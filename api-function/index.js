import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import crypto from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,DELETE",
};

export const handler = async (event) => {
    console.log("🟢 [API] Incoming event:", JSON.stringify({
        httpMethod: event?.httpMethod,
        path: event?.path,
        resource: event?.resource,
        qs: event?.queryStringParameters,
        pathParams: event?.pathParameters
    }));
    
    try {
        if (event.httpMethod === "OPTIONS") {
            console.log("🟢 [API] OPTIONS preflight");
            return { statusCode: 200, headers: cors, body: "" };
        }
        
        const { TABLE_NAME, QUEUE_URL } = process.env;
        if (!TABLE_NAME) {
            console.error("🔴 [CFG] TABLE_NAME not set");
            return res(500, { message: "TABLE_NAME not set" });
        }
        
        // POST /tasks — створити задачу + (опц.) покласти в SQS
        if (event.httpMethod === "POST" && event.path?.endsWith("/tasks")) {
            console.log("🟢 [ROUTE] POST /tasks");
            
            let body;
            try { body = typeof event.body === "string" ? JSON.parse(event.body) : event.body; }
            catch { console.warn("🟠 [VALIDATION] Invalid JSON body"); return res(400, { message: "Invalid JSON" }); }
            
            const topic = (body?.topic || "").trim();
            if (!topic) { console.warn("🟠 [VALIDATION] Missing 'topic'"); return res(422, { message: "Field 'topic' is required" }); }
            
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            
            const item = { id, topic, status: "QUEUED", createdAt: now, updatedAt: now, researchMd: "", error: null };
            
            console.log("🟢 [DynamoDB] Put item:", item);
            await ddb.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: item,
                ConditionExpression: "attribute_not_exists(id)"
            }));
            
            if (QUEUE_URL) {
                const sqsPayload = { id, topic, requestedAt: now, taskType: "RESEARCH_SUMMARY_V1" };
                console.log("🟢 [SQS] SendMessage to", QUEUE_URL, "payload:", sqsPayload);
                const sqsRes = await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(sqsPayload) }));
                console.log("🟢 [SQS] MessageId:", sqsRes?.MessageId);
            } else {
                console.log("🟠 [SQS] QUEUE_URL not set — skipping enqueue");
            }
            
            return res(201, { id, topic, status: "QUEUED", createdAt: now });
        }
        
        // GET /tasks — список задач (простий Scan з курсором)
        if (event.httpMethod === "GET" && event.path?.endsWith("/tasks") && event.resource !== "/tasks/{id}") {
            console.log("🟢 [ROUTE] GET /tasks");
            
            const qs = event.queryStringParameters || {};
            const limit = Math.min(Number(qs.limit || 25), 100);
            const startKey = qs.cursor ? JSON.parse(Buffer.from(qs.cursor, "base64").toString("utf8")) : undefined;
            
            console.log("🟢 [DynamoDB] Scan start. limit:", limit, "startKey:", startKey);
            const out = await ddb.send(new ScanCommand({
                TableName: TABLE_NAME,
                ProjectionExpression: "id, topic, #s, createdAt, updatedAt",
                ExpressionAttributeNames: { "#s": "status" },
                Limit: limit,
                ExclusiveStartKey: startKey
            }));
            const cursor = out.LastEvaluatedKey ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64") : null;
            console.log("🟢 [DynamoDB] Scan done. count:", (out.Items || []).length, "hasMore:", !!out.LastEvaluatedKey);
            
            return res(200, { items: out.Items || [], cursor });
        }
        
        // GET /tasks/{id} — один запис (включно з researchMd)
        if (event.httpMethod === "GET" && event.resource === "/tasks/{id}") {
            const id = event.pathParameters?.id;
            console.log("🟢 [ROUTE] GET /tasks/{id} id:", id);
            if (!id) return res(400, { message: "Missing path param 'id'" });
            
            const out = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { id } }));
            if (!out.Item) {
                console.warn("🟠 [DynamoDB] Not found id:", id);
                return res(404, { message: "Not Found" });
            }
            console.log("🟢 [DynamoDB] Found item id:", id);
            return res(200, out.Item);
        }
        
        // DELETE /tasks/{id}
        if (event.httpMethod === "DELETE" && event.resource === "/tasks/{id}") {
            const id = event.pathParameters?.id;
            console.log("🟢 [ROUTE] DELETE /tasks/{id} id:", id);
            if (!id) return res(400, { message: "Missing path param 'id'" });
            
            await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { id } }));
            console.log("🟢 [DynamoDB] Deleted id:", id);
            return res(204, "");
        }
        
        console.warn("🟠 [API] No route match for:", event.httpMethod, event.path, event.resource);
        return res(404, { message: "Not Found" });
    } catch (err) {
        console.error("🔴 [API] Unhandled error:", err);
        return res(500, { message: "Server error", error: err?.message });
    }
};

function res(statusCode, data) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    console.log("🟢 [API] Response", statusCode, payload.length > 600 ? payload.slice(0, 600) + "…(truncated)" : payload);
    return { statusCode, headers: cors, body: payload };
}

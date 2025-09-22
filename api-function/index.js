import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    PutCommand,
    DeleteCommand,
    GetCommand,
    QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import crypto from "node:crypto";

/**
* --------------------------------------------
* Config via SSM Parameter Store
* --------------------------------------------
* Ключі очікуються в SSM:
*  - /ai-studynotes/dynamo-db-table-name  (String або SecureString)
*  - /ai-studynotes/sqs-queue-url         (String або SecureString, опціонально)
*
* Можна змінити базовий шлях і TTL кешу через env:
*  - CONFIG_BASE_PATH (дефолт: "/ai-studynotes")
*  - CONFIG_TTL_MS    (дефолт: 300000 = 5 хв)
*/

const CONFIG_BASE_PATH = process.env.CONFIG_BASE_PATH || "/ai-studynotes";
const CONFIG_TTL_MS = Number(process.env.CONFIG_TTL_MS || 5 * 60 * 1000); // 5 хв кешу

const ssm = new SSMClient({});
let cachedConfig = null;
let cachedAt = 0;

async function loadConfig() {
    const now = Date.now();
    if (cachedConfig && now - cachedAt < CONFIG_TTL_MS) return cachedConfig;
    
    const params = {};
    let nextToken = undefined;
    
    do {
        const out = await ssm.send(
            new GetParametersByPathCommand({
                Path: CONFIG_BASE_PATH,
                Recursive: false,
                WithDecryption: true,
                NextToken: nextToken,
            })
        );
        
        for (const p of out.Parameters ?? []) {
            // "/ai-studynotes/dynamo-db-table-name" -> "dynamo-db-table-name"
            const key = p.Name?.split("/").pop();
            if (key && p.Value != null) params[key] = p.Value;
        }
        nextToken = out.NextToken;
    } while (nextToken);
    
    cachedConfig = params;
    cachedAt = now;
    return params;
}

/**
* --------------------------------------------
* AWS clients
* --------------------------------------------
*/
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

/**
* --------------------------------------------
* CORS
* --------------------------------------------
*/
const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,DELETE",
};

/**
* --------------------------------------------
* Lambda handler
* --------------------------------------------
*/
export const handler = async (event) => {
    console.log(
        "🟢 [API] Incoming event:",
        JSON.stringify({
            httpMethod: event?.httpMethod,
            path: event?.path,
            resource: event?.resource,
            qs: event?.queryStringParameters,
            pathParams: event?.pathParameters,
        })
    );
    
    try {
        if (event.httpMethod === "OPTIONS") {
            console.log("🟢 [API] OPTIONS preflight");
            return { statusCode: 200, headers: cors, body: "" };
        }
        
        const config = await loadConfig();
        const tableName = config["dynamo-db-table-name"];
        const queueUrl = config["sqs-queue-url"]; // може бути undefined
        
        if (!tableName) {
            console.error("🔴 [CFG] dynamo-db-table-name not set in SSM");
            return res(500, { message: "dynamo-db-table-name not set" });
        }
        
        // POST /tasks — створити задачу + (опц.) покласти в SQS
        if (event.httpMethod === "POST" && event.path?.endsWith("/tasks")) {
            console.log("🟢 [ROUTE] POST /tasks");
            
            let body;
            try {
                body =
                typeof event.body === "string" ? JSON.parse(event.body) : event.body;
            } catch {
                console.warn("🟠 [VALIDATION] Invalid JSON body");
                return res(400, { message: "Invalid JSON" });
            }
            
            const topic = (body?.topic || "").trim();
            if (!topic) {
                console.warn("🟠 [VALIDATION] Missing 'topic'");
                return res(422, { message: "Field 'topic' is required" });
            }
            
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            
            const item = {
                id,
                pk: "TASK",
                topic,
                status: "QUEUED",
                createdAt: now,
                updatedAt: now,
                researchMd: "",
                error: null,
            };
            
            console.log("🟢 [DynamoDB] Put item:", item);
            await ddb.send(
                new PutCommand({
                    TableName: tableName,
                    Item: item,
                    ConditionExpression: "attribute_not_exists(id)",
                })
            );
            
            if (queueUrl) {
                const sqsPayload = {
                    id,
                    topic,
                    requestedAt: now,
                    taskType: "RESEARCH_SUMMARY_V1",
                };
                console.log(
                    "🟢 [SQS] SendMessage to",
                    queueUrl,
                    "payload:",
                    sqsPayload
                );
                const sqsRes = await sqs.send(
                    new SendMessageCommand({
                        QueueUrl: queueUrl,
                        MessageBody: JSON.stringify(sqsPayload),
                    })
                );
                console.log("🟢 [SQS] MessageId:", sqsRes?.MessageId);
            } else {
                console.log("🟠 [SQS] sqs-queue-url not set — skipping enqueue");
            }
            
            return res(201, { id, topic, status: "QUEUED", createdAt: now });
        }
        
        // GET /tasks — відсортований список (нові → старі) з курсором через GSI byCreatedAt
        if (
            event.httpMethod === "GET" &&
            event.path?.endsWith("/tasks") &&
            event.resource !== "/tasks/{id}"
        ) {
            console.log("🟢 [ROUTE] GET /tasks");
            
            const qs = event.queryStringParameters || {};
            const limit = Math.min(Number(qs.limit || 25), 100);
            const startKey = qs.cursor
            ? JSON.parse(Buffer.from(qs.cursor, "base64").toString("utf8"))
            : undefined;
            
            console.log(
                "🟢 [DynamoDB] Query start (byCreatedAt). limit:",
                limit,
                "startKey:",
                startKey
            );
            const out = await ddb.send(
                new QueryCommand({
                    TableName: tableName,
                    IndexName: "byCreatedAt",
                    KeyConditionExpression: "pk = :p",
                    ExpressionAttributeValues: { ":p": "TASK" },
                    Limit: limit,
                    ScanIndexForward: false,
                    ExclusiveStartKey: startKey,
                    ProjectionExpression: "id, topic, #s, createdAt, updatedAt",
                    ExpressionAttributeNames: { "#s": "status" },
                })
            );
            const cursor = out.LastEvaluatedKey
            ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64")
            : null;
            console.log(
                "🟢 [DynamoDB] Query done. count:",
                (out.Items || []).length,
                "hasMore:",
                !!out.LastEvaluatedKey
            );
            
            return res(200, { items: out.Items || [], cursor });
        }
        
        // GET /tasks/{id} — один запис (включно з researchMd)
        if (event.httpMethod === "GET" && event.resource === "/tasks/{id}") {
            const id = event.pathParameters?.id;
            console.log("🟢 [ROUTE] GET /tasks/{id} id:", id);
            if (!id) return res(400, { message: "Missing path param 'id'" });
            
            const out = await ddb.send(
                new GetCommand({ TableName: tableName, Key: { id } })
            );
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
            
            await ddb.send(new DeleteCommand({ TableName: tableName, Key: { id } }));
            console.log("🟢 [DynamoDB] Deleted id:", id);
            return res(204, "");
        }
        
        console.warn(
            "🟠 [API] No route match for:",
            event.httpMethod,
            event.path,
            event.resource
        );
        return res(404, { message: "Not Found" });
    } catch (err) {
        console.error("🔴 [API] Unhandled error:", err);
        return res(500, { message: "Server error", error: err?.message });
    }
};

function res(statusCode, data) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    console.log(
        "🟢 [API] Response",
        statusCode,
        payload.length > 600
        ? payload.slice(0, 600) + "…(truncated)"
        : payload
    );
    return { statusCode, headers: cors, body: payload };
}
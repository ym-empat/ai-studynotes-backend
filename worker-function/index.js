import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

/**
* ---------------------------------------------------------
* 🔧 Config via SSM Parameter Store (kebab-case)
* ---------------------------------------------------------
* Очікувані ключі під префіксом /ai-studynotes:
*  - /ai-studynotes/dynamo-db-table-name   (String або SecureString)
*  - /ai-studynotes/sns-topic-arn          (String або SecureString, опціонально)
*  - /ai-studynotes/openai-api-key         (SecureString)
*  - /ai-studynotes/openai-prompt-id       (String або SecureString)
*
* Опції через env:
*  - CONFIG_BASE_PATH (дефолт: "/ai-studynotes")
*  - CONFIG_TTL_MS    (дефолт: 300000 = 5 хв)
*/
const CONFIG_BASE_PATH = process.env.CONFIG_BASE_PATH || "/ai-studynotes";
const CONFIG_TTL_MS = Number(process.env.CONFIG_TTL_MS || 5 * 60 * 1000); // 5 хв кеш

const ssm = new SSMClient({});
let cachedConfig = null;
let cachedAt = 0;

async function loadConfig() {
    const now = Date.now();
    if (cachedConfig && now - cachedAt < CONFIG_TTL_MS) return cachedConfig;
    
    const params = {};
    let nextToken = undefined;
    
    try {
        do {
            const out = await ssm.send(
                new GetParametersByPathCommand({
                    Path: CONFIG_BASE_PATH,
                    Recursive: false,
                    WithDecryption: true, // важливо для SecureString
                    NextToken: nextToken,
                })
            );
            
            for (const p of out.Parameters ?? []) {
                // "/ai-studynotes/openai-api-key" -> "openai-api-key"
                const key = p.Name?.split("/").pop();
                if (key && p.Value != null) params[key] = p.Value;
            }
            nextToken = out.NextToken;
        } while (nextToken);
    } catch (e) {
        console.error("🔴 [CFG] Failed to load SSM params:", {
            name: e?.name,
            message: e?.message,
            status: e?.$metadata?.httpStatusCode,
        });
        throw e;
    }
    
    // Мінімальна валідація критичних ключів
    const required = ["dynamo-db-table-name", "openai-api-key", "openai-prompt-id"];
    const missing = required.filter((k) => !params[k]);
    if (missing.length) {
        throw new Error(`Missing SSM parameters: ${missing.join(", ")}`);
    }
    
    cachedConfig = params;
    cachedAt = now;
    return params;
}

/**
* ---------------------------------------------------------
* 🗃️ AWS clients
* ---------------------------------------------------------
*/
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

/**
* ---------------------------------------------------------
* 🧩 Helpers
* ---------------------------------------------------------
*/
function extractMarkdown(data) {
    if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
    
    // Responses API shape: output: [{ content: [{ type:'output_text', text:'...' }, ...] }, ...]
    if (Array.isArray(data?.output)) {
        const parts = [];
        for (const blk of data.output) {
            const content = blk?.content || blk?.contents || [];
            for (const c of content) {
                if (typeof c === "string") parts.push(c);
                else if (typeof c?.text === "string") parts.push(c.text);
                else if (typeof c?.text?.value === "string") parts.push(c.text.value);
                else if (typeof c?.output_text === "string") parts.push(c.output_text);
            }
        }
        const md = parts.join("").trim();
        if (md) return md;
    }
    
    // Older shapes:
    if (Array.isArray(data?.content)) {
        const md = data.content
        .map((c) =>
            typeof c?.text?.value === "string"
        ? c.text.value
        : typeof c?.text === "string"
        ? c.text
        : ""
    )
    .join("")
    .trim();
    if (md) return md;
}
return "";
}

async function callOpenAIWithPrompt(topic, apiKey, promptId) {
    console.log("🟢 [OpenAI] Request for topic:", topic);
    
    const body = {
        prompt: {
            id: String(promptId),
            variables: { topic },
        },
    };
    
    const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    
    console.log("🟢 [OpenAI] HTTP status:", res.status);
    
    if (!res.ok) {
        const txt = await res.text();
        console.error("🔴 [OpenAI] Error:", txt.slice(0, 800));
        throw new Error(`OpenAI ${res.status}: ${txt}`);
    }
    
    const data = await res.json();
    const md = extractMarkdown(data);
    if (!md) {
        console.warn("🟠 [OpenAI] Unexpected shape, first 400 chars of JSON:", JSON.stringify(data).slice(0, 400));
        throw new Error("Empty OpenAI response");
    }
    
    console.log("🟢 [OpenAI] Markdown length:", md.length);
    return md;
}

/**
* ---------------------------------------------------------
* 🧠 Lambda handler (SQS trigger)
* ---------------------------------------------------------
*/
export const handler = async (event) => {
    console.log("🟢 [Lambda] Event:", JSON.stringify({ records: event?.Records?.length || 0 }));
    
    const failures = [];
    let cfg;
    try {
        cfg = await loadConfig();
    } catch (e) {
        console.error("🔴 [Lambda] Config load failed — abort batch:", e?.message);
        // Якщо конфіг не піднявся, відмічаємо всі записи як failed, щоб SQS ретраїв
        const all = (event.Records ?? []).map((r) => ({ itemIdentifier: r.messageId }));
        return { batchItemFailures: all };
    }
    
    // Безпечний доступ до значень
    const TABLE_NAME = cfg["dynamo-db-table-name"];
    const SNS_TOPIC_ARN = cfg["sns-topic-arn"]; // опціонально
    const OPENAI_API_KEY = cfg["openai-api-key"];
    const OPENAI_PROMPT_ID = cfg["openai-prompt-id"];
    
    for (const rec of event.Records ?? []) {
        console.log("🟢 [Record] Start:", rec.messageId);
        try {
            const msg = JSON.parse(rec.body);
            const id = msg.id;
            const topic = msg.topic;
            console.log("🟢 [Record] Body:", { id, topic });
            if (!id || !topic) throw new Error("Message must contain id and topic");
            
            console.log(`🟢 [DynamoDB] Set PROCESSING id=${id}`);
            await ddb.send(
                new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { id },
                    UpdateExpression: "SET #s = :s, updatedAt = :t",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":s": "PROCESSING", ":t": new Date().toISOString() },
                })
            );
            
            const markdown = await callOpenAIWithPrompt(topic, OPENAI_API_KEY, OPENAI_PROMPT_ID);
            
            console.log(`🟢 [DynamoDB] Write DONE + researchMd id=${id}`);
            await ddb.send(
                new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { id },
                    UpdateExpression: "SET researchMd = :md, #s = :s, updatedAt = :t REMOVE #e",
                    ExpressionAttributeNames: { "#s": "status", "#e": "error" },
                    ExpressionAttributeValues: {
                        ":md": markdown,
                        ":s": "DONE",
                        ":t": new Date().toISOString(),
                    },
                })
            );
            
            if (SNS_TOPIC_ARN) {
                console.log(`🟢 [SNS] Publish ready for id=${id}`);
                await sns.send(
                    new PublishCommand({
                        TopicArn: SNS_TOPIC_ARN,
                        Subject: "Конспект готовий",
                        Message: `Конспект на тему "${topic}" готовий. ID: ${id}`,
                    })
                );
            } else {
                console.log("🟠 [SNS] sns-topic-arn not set — skipping publish");
            }
            
            console.log(`✅ [Record] Success ${rec.messageId}`);
        } catch (err) {
            console.error("🔴 [Record] Error:", err?.message || err);
            failures.push({ itemIdentifier: rec.messageId });
            
            // Спробуємо позначити запис як ERROR у БД
            try {
                const safe = JSON.parse(rec.body);
                if (safe?.id) {
                    console.log(`🟠 [DynamoDB] Mark ERROR id=${safe.id}`);
                    await ddb.send(
                        new UpdateCommand({
                            TableName: TABLE_NAME,
                            Key: { id: safe.id },
                            UpdateExpression: "SET #e = :e, #s = :s, updatedAt = :t",
                            ExpressionAttributeNames: { "#e": "error", "#s": "status" },
                            ExpressionAttributeValues: {
                                ":e": String(err?.message || err),
                                ":s": "ERROR",
                                ":t": new Date().toISOString(),
                            },
                        })
                    );
                }
            } catch (nested) {
                console.error("🔴 [Record] Failed to mark ERROR:", nested?.message || nested);
            }
        }
    }
    
    console.log("🟢 [Lambda] Done. batchItemFailures:", failures);
    return { batchItemFailures: failures };
};
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROMPT_ID = process.env.OPENAI_PROMPT_ID;

function extractMarkdown(data) {
    if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
    
    // Responses API sometimes returns: output: [{ content: [{ type:'output_text', text:'...' }, ...] }, ...]
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
    
    // Fallback older shapes
    if (Array.isArray(data?.content)) {
        const md = data.content
        .map(c => (typeof c?.text?.value === "string" ? c.text.value : (typeof c?.text === "string" ? c.text : "")))
        .join("")
        .trim();
        if (md) return md;
    }
    return "";
}

async function callOpenAIWithPrompt(topic) {
    console.log("🟢 [OpenAI] Request for topic:", topic);
    
    const body = {
        prompt: {
            id: `${OPENAI_PROMPT_ID}`,
            variables: { topic }
        }
    };
    
    const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
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

export const handler = async (event) => {
    console.log("🟢 [Lambda] Event:", JSON.stringify(event));
    const failures = [];
    
    for (const rec of event.Records ?? []) {
        console.log("🟢 [Record] Start:", rec.messageId);
        try {
            const msg = JSON.parse(rec.body);
            const id = msg.id;
            const topic = msg.topic;
            console.log("🟢 [Record] Body:", msg);
            if (!id || !topic) throw new Error("Message must contain id and topic");
            
            console.log(`🟢 [DynamoDB] Set PROCESSING id=${id}`);
            await ddb.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { id },
                UpdateExpression: "SET #s = :s, updatedAt = :t",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":s": "PROCESSING", ":t": new Date().toISOString() }
            }));
            
            const markdown = await callOpenAIWithPrompt(topic);
            
            console.log(`🟢 [DynamoDB] Write DONE + researchMd id=${id}`);
            await ddb.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { id },
                UpdateExpression: "SET researchMd = :md, #s = :s, updatedAt = :t REMOVE #e",
                ExpressionAttributeNames: { "#s": "status", "#e": "error" },
                ExpressionAttributeValues: {
                    ":md": markdown,
                    ":s": "DONE",
                    ":t": new Date().toISOString()
                }
            }));
            
            if (SNS_TOPIC_ARN) {
                console.log(`🟢 [SNS] Publish ready for id=${id}`);
                await sns.send(new PublishCommand({
                    TopicArn: SNS_TOPIC_ARN,
                    Subject: "Конспект готовий",
                    Message: `Конспект на тему "${topic}" готовий. ID: ${id}`
                }));
            }
            
            console.log(`✅ [Record] Success ${rec.messageId}`);
        } catch (err) {
            console.error("🔴 [Record] Error:", err);
            failures.push({ itemIdentifier: rec.messageId });
            
            try {
                const safe = JSON.parse(rec.body);
                if (safe?.id) {
                    console.log(`🟠 [DynamoDB] Mark ERROR id=${safe.id}`);
                    await ddb.send(new UpdateCommand({
                        TableName: TABLE_NAME,
                        Key: { id: safe.id },
                        UpdateExpression: "SET #e = :e, #s = :s, updatedAt = :t",
                        ExpressionAttributeNames: { "#e": "error", "#s": "status" },
                        ExpressionAttributeValues: {
                            ":e": String(err?.message || err),
                            ":s": "ERROR",
                            ":t": new Date().toISOString()
                        }
                    }));
                }
            } catch (nested) {
                console.error("🔴 [Record] Failed to mark ERROR:", nested);
            }
        }
    }
    
    console.log("🟢 [Lambda] Done. batchItemFailures:", failures);
    return { batchItemFailures: failures };
};
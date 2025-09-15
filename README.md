# AI Study Notes Backend

A serverless backend service for generating AI-powered study notes and research summaries. This project uses AWS Lambda functions to create an asynchronous processing pipeline that generates comprehensive study materials from topic inputs.

## 🚀 Features

- **Asynchronous Processing**: Submit study topics and receive AI-generated notes when ready
- **RESTful API**: Clean HTTP endpoints for task management
- **Queue-based Architecture**: Uses AWS SQS for reliable message processing
- **Real-time Notifications**: SNS integration for completion alerts
- **Scalable Storage**: DynamoDB for persistent data storage
- **CORS Support**: Ready for frontend integration

## 🏗️ Architecture

The system consists of two main Lambda functions:

### API Function (`api-function/`)
Handles HTTP requests and provides the following endpoints:
- `POST /tasks` - Create a new study note task
- `GET /tasks` - List all tasks with pagination
- `GET /tasks/{id}` - Get specific task details including generated content
- `DELETE /tasks/{id}` - Delete a task

### Worker Function (`worker-function/`)
Processes tasks from the SQS queue:
- Consumes messages from SQS
- Calls OpenAI API to generate study notes
- Updates task status in DynamoDB
- Sends completion notifications via SNS

## 📋 API Endpoints

### Create Task
```http
POST /tasks
Content-Type: application/json

{
  "topic": "Machine Learning Fundamentals"
}
```

**Response:**
```json
{
  "id": "uuid",
  "topic": "Machine Learning Fundamentals",
  "status": "QUEUED",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

### List Tasks
```http
GET /tasks?limit=25&cursor=base64_encoded_cursor
```

**Response:**
```json
{
  "items": [
    {
      "id": "uuid",
      "topic": "Machine Learning Fundamentals",
      "status": "DONE",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:01:00.000Z"
    }
  ],
  "cursor": "base64_encoded_cursor"
}
```

### Get Task Details
```http
GET /tasks/{id}
```

**Response:**
```json
{
  "id": "uuid",
  "topic": "Machine Learning Fundamentals",
  "status": "DONE",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:01:00.000Z",
  "researchMd": "# Machine Learning Fundamentals\n\n## Overview\n..."
}
```

### Delete Task
```http
DELETE /tasks/{id}
```

**Response:** `204 No Content`

## 🔧 Environment Variables

### API Function
- `TABLE_NAME` - DynamoDB table name for storing tasks
- `QUEUE_URL` - SQS queue URL for task processing

### Worker Function
- `TABLE_NAME` - DynamoDB table name for storing tasks
- `SNS_TOPIC_ARN` - SNS topic ARN for completion notifications
- `OPENAI_API_KEY` - OpenAI API key for generating content
- `OPENAI_PROMPT_ID` - OpenAI prompt template ID

## 📊 Task Status Flow

1. **QUEUED** - Task created and added to processing queue
2. **PROCESSING** - Worker function is generating the study notes
3. **DONE** - Study notes generated successfully
4. **ERROR** - Processing failed (check error field for details)

## 🛠️ AWS Services Used

- **AWS Lambda** - Serverless compute for API and worker functions
- **Amazon DynamoDB** - NoSQL database for task storage
- **Amazon SQS** - Message queue for asynchronous processing
- **Amazon SNS** - Notification service for task completion alerts
- **OpenAI API** - AI service for generating study notes

## 📁 Project Structure

```
ai-studynotes-backend/
├── api-function/
│   └── index.js          # API Lambda function
├── worker-function/
│   └── index.js          # Worker Lambda function
├── LICENSE               # GNU GPL v3 License
└── README.md            # This file
```

## 🚀 Deployment

This project is designed to be deployed on AWS using serverless frameworks like:
- AWS SAM (Serverless Application Model)
- Serverless Framework
- AWS CDK (Cloud Development Kit)

### Prerequisites
- AWS CLI configured
- Node.js runtime
- AWS Lambda deployment tools

### Required AWS Resources
- DynamoDB table with GSI `byCreatedAt`
- SQS queue for task processing
- SNS topic for notifications
- IAM roles with appropriate permissions

## 🔐 Security

- CORS headers configured for cross-origin requests
- Input validation on all endpoints
- Error handling with appropriate HTTP status codes
- Secure environment variable management

## 📝 License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📞 Support

For questions or issues, please open an issue in the repository or contact the maintainers.

---

**Note**: This backend service requires proper AWS infrastructure setup and OpenAI API credentials to function correctly.

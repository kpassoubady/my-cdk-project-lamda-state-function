import { S3 } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const s3 = new S3();
const sfnClient = new SFNClient();

// Replace with your Step Functions state machine ARN
const stateMachineArn = "arn:aws:states:us-east-2:703671907972:stateMachine:CdkETL-Customer-Data-Pipeline";

export async function handler(event) {
    console.log("Received Event:", JSON.stringify(event, null, 2));

    let bucketName, objectKey;

    try {
        // Check the event structure (S3 or Step Functions payload)
        if (event.Records && event.Records[0]) {
            // S3 Event
            bucketName = event.Records[0].s3.bucket.name;
            objectKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
        } else if (event.bucketName && event.objectKey) {
            // Step Function Event
            bucketName = event.bucketName;
            objectKey = event.objectKey;
        } else {
            throw new Error("Unsupported event format");
        }

        console.log(`Processing file from bucket: ${bucketName}, key: ${objectKey}`);

        // Ensure the file is from the sources/ folder
        if (!objectKey.startsWith("sources/")) {
            console.log(`File ${objectKey} is not in the sources/ folder. Skipping.`);
            return {
            statusCode: 200,
            body: JSON.stringify({ message: "File not in sources/ folder. Skipping." }),
            };
        }

        if (objectKey.startsWith("processed/")) {
            console.log(`File ${objectKey} is already in the processed/ folder. Skipping.`);
            return {
                statusCode: 200,
                body: JSON.stringify({ message: "File already processed. Skipping." }),
            };
        }

        // Fetch the file from S3
        const params = { Bucket: bucketName, Key: objectKey };
        const data = await s3.getObject(params);

        const streamToString = (stream) =>
            new Promise((resolve, reject) => {
                const chunks = [];
                stream.on("data", (chunk) => chunks.push(chunk));
                stream.on("error", reject);
                stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
            });

        const fileContent = await streamToString(data.Body);

        console.log("First 100 characters of the file:", fileContent.substring(0, 100));

        // Parse the CSV content
        const lines = fileContent.split("\n");
        const headers = lines[0].split(",");
        const firstNameIndex = headers.indexOf("First Name");

        if (firstNameIndex !== -1) {
            for (let i = 1; i < lines.length; i++) {
                const columns = lines[i].split(",");
                const firstName = columns[firstNameIndex];
                if (firstName) console.log("First Name:", firstName);
            }
        } else {
            console.log("First Name column not found in the CSV file.");
        }

        // Move the file to the processed/ prefix
        const fileName = objectKey.split('/').pop();
        const processedKey = `processed/${fileName}`;
        console.log(`Moving file to: ${processedKey}`);

        // Copy the object
        await s3.copyObject({
            Bucket: bucketName,
            CopySource: `${bucketName}/${objectKey}`,
            Key: processedKey,
        });
        console.log(`File copied to: ${processedKey}`);

        // Delete the original object
        await s3.deleteObject({ Bucket: bucketName, Key: objectKey });
        console.log(`Original file deleted: ${objectKey}`);

        // Start the Step Function workflow
        const input = JSON.stringify({
            bucketName,
            objectKey: processedKey, // Pass the new key to the Step Function
            filePreview: fileContent.substring(0, 100), // Example: send a preview of the file to Step Functions
        });

        const command = new StartExecutionCommand({
            stateMachineArn,
            input,
        });

        const response = await sfnClient.send(command);
        console.log("Step Function Execution Started:", response);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "File processed successfully!",
                executionArn: response.executionArn,
            }),
        };
    } catch (error) {
        console.error("Error processing file:", error);
        // return {
        //     statusCode: 500,
        //     body: JSON.stringify({
        //         message: "Error processing file",
        //         error: error.message,
        //     }),
        // };

        // Throw an error to indicate failure
        throw new Error(
            JSON.stringify({
                message: "Error processing file",
                error: error.message,
            })
        );
    }
}

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';

export class MyCdkProjectStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Create a VPC (or use an existing one)
        const vpc = new ec2.Vpc(this, 'LambdaVpc', {
            maxAzs: 2, // Default is all AZs in the region
        });

        // Create the IAM role for the Lambda function
        const lambdaRole = new iam.Role(this, 'CustomerLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/lambda/*`],
        }));

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:PutObject', 's3:DeleteObject'],
            resources: [
                'arn:aws:s3:::customer-data-bucket-703671907972-us-east-2',
                'arn:aws:s3:::customer-data-bucket-703671907972-us-east-2/*',
            ],
        }));

        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: ['states:StartExecution'],
            resources: ['arn:aws:states:us-east-2:703671907972:stateMachine:CdkETL-Customer-Data-Pipeline'],
        }));

        // Add permissions for creating network interfaces
        lambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'ec2:CreateNetworkInterface',
                'ec2:DescribeNetworkInterfaces',
                'ec2:DeleteNetworkInterface',
                'ec2:AssignPrivateIpAddresses',
                'ec2:UnassignPrivateIpAddresses'
            ],
            resources: ['*'],
        }));

        // Create the Lambda function
        const lambdaFn = new lambda.Function(this, 'CustomerLambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset('lambda'), // Path to your Lambda code
            vpc,
            role: lambdaRole,
        });

        // Create an S3 bucket with a unique name
        const customerDataBucket = new s3.Bucket(this, 'CdkCustomerDataBucket', {
          bucketName: `customer-data-bucket-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
          removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production code
        });

        // Create the IAM role for the Step Functions state machine
        const stateMachineRole = new iam.Role(this, 'CdkETLCustomerDataPipelineRole', {
            assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
        });

        stateMachineRole.addToPolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [lambdaFn.functionArn],
        }));

        // Define the state machine tasks
        const processFileTask = new sfnTasks.LambdaInvoke(this, 'ProcessFile', {
            lambdaFunction: lambdaFn,
            retryOnServiceExceptions: true,
            outputPath: '$.Payload',
        });

        const logError = new sfn.Fail(this, 'LogError', {
            error: 'ProcessingFailed',
            cause: 'Lambda function failed to process the file',
        });

        // Define the state machine
        const definition = processFileTask.addCatch(logError, { resultPath: '$.error-info' });

        const stateMachine = new sfn.StateMachine(this, 'CdkETLCustomerDataPipeline', {
            definition,
            stateMachineName: 'CdkETL-Customer-Data-Pipeline',
            role: stateMachineRole,
        });

        // Define the custom resource Lambda function
        const customResourceLambda = new lambda.Function(this, 'CustomVpcRestrictDefaultSGFunction', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset('lambda'), // Updated path to your custom resource Lambda code
        });

        // Create the custom resource
        new cr.AwsCustomResource(this, 'VpcRestrictDefaultSG', {
            onCreate: {
                service: 'EC2',
                action: 'modifyVpcAttribute',
                parameters: {
                    VpcId: vpc.vpcId,
                    EnableDnsSupport: {
                        Value: true,
                    },
                },
                physicalResourceId: cr.PhysicalResourceId.of('VpcRestrictDefaultSG'),
            },
            policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
        });
    }
}

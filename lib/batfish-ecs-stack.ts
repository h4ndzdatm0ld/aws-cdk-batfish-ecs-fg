import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import { aws_ssm as ssm } from 'aws-cdk-lib';

export class BatfishEcsStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC
    const vpc = new ec2.Vpc(this, 'BatfishVpc', {
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'BatfishPrivateWithEgress',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'BatfishPublic',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ]
    });
    this.vpc = vpc;

    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, 'BatfishCluster', {
      vpc: vpc,
      containerInsights: true
    });

    // Create Task Definition with Fargate compatibility
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BatfishTaskDefinition', {
      memoryLimitMiB: 4096,
      cpu: 2048,
      family: 'ecs-exec-task', // Set the family property
      executionRole: new iam.Role(this, 'ExecutionRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        ],
      }),
      taskRole: new iam.Role(this, 'TaskRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      }),
    });

    // Add the required IAM policy to the task role to grant access to the necessary SSM actions
    const ssmPolicy = new iam.PolicyStatement({
      actions: [
        'ssm:DescribeSessions',
        'ssm:GetConnectionStatus',
        'ssm:GetDocument',
        'ssm:StartSession',
        'ssm:TerminateSession',
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel"
      ],
      resources: ['*'],
    });

    // Attach the policy statement to the task role
    new iam.Policy(this, 'SSMPolicy', {
      statements: [ssmPolicy],
      roles: [taskDefinition.taskRole],
    });

    // Add container to the task definition
    const container = taskDefinition.addContainer('BatfishContainer', {
      image: ecs.ContainerImage.fromRegistry('batfish/allinone:latest'),
      logging: ecs.LogDrivers.awsLogs(
        { streamPrefix: 'Batfish' }
      ),
      memoryLimitMiB: 4096,
      cpu: 2048,
      environment: {
        BASH_ENV: '/etc/profile'
      },
      healthCheck: {
        command: [
          'CMD-SHELL', 'timeout 10s bash -c \':> /dev/tcp/127.0.0.1/9996\' || exit 1'
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10)
      },
    });
    // Fargate Security Group
    const fargateServiceSecurityGroup = new ec2.SecurityGroup(this, 'FargateServiceSecurityGroup', {
      vpc: vpc,
    });

    // Create a Fargate service
    const fargateService = new ecs.FargateService(this, 'BatfishFargateService', {
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: vpc,
      securityGroups: [fargateServiceSecurityGroup],
    });

    // Create a new Application Load Balancer | Non-internet facing (Access through SSM EC2)
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'BatfishLoadBalancer', {
      loadBalancerName: 'BatfishLoadBalancer',
      vpc: vpc,
      internetFacing: true
    });
    cdk.Tags.of(loadBalancer).add('Name', 'BatfishLoadBalancer');
    this.loadBalancer = loadBalancer;

    // Add an ingress rule to allow traffic on port 8888/9996 | Container Port Mappings
    const portNumbers = [9996, 8888];
    // Create container port mappings
    const portMappings = portNumbers.map((portNumber) => ({ containerPort: portNumber }));
    // Add port mappings to the container
    container.addPortMappings(...portMappings);

    // Create the target groups and associate with listeners
    const targetGroups: elbv2.ApplicationTargetGroup[] = [];

    for (const portNumber of portNumbers) {
      // Create a separate target group for each port
      const targetGroup = new elbv2.ApplicationTargetGroup(this, `TargetGroup${portNumber}`, {
        targetGroupName: `ALB-TargetGroup-${portNumber}`,
        targetType: elbv2.TargetType.IP,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: portNumber,
        vpc: vpc,
        targets: [fargateService.loadBalancerTarget({
          containerName: 'BatfishContainer',
          containerPort: portNumber
        })],
        stickinessCookieDuration: cdk.Duration.seconds(120),
        healthCheck: {
          path: '/',
          port: '8888',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyHttpCodes: '200,302',
        },
      });

      targetGroups.push(targetGroup);

      loadBalancer.addListener(`Listener${portNumber}`, {
        port: portNumber,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.weightedForward(
          [{
            targetGroup: targetGroup,
            weight: 1
          }],
          {
            stickinessDuration: cdk.Duration.seconds(900),
          }
        ),
      });
    }

    // Create a new EC2 Service
    const amazonLinuxAmi = new ec2.AmazonLinuxImage({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2
    });

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Create a CloudWatch Log Group
    const sessionManagerLogGroup = new logs.LogGroup(this, 'SessionManagerLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create an S3 bucket for SSM logs
    const ssmLogsBucket = new s3.Bucket(this, 'SSMLogsBucket', {
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN if you want to keep the bucket when the stack is deleted
    });

    // Add an inline policy to the instance role for writing logs to the S3 bucket
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:PutObject',
        's3:GetBucketAcl',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        ssmLogsBucket.bucketArn,
        `${ssmLogsBucket.bucketArn}/*`,
        sessionManagerLogGroup.logGroupArn,
      ],
    }));

    const instanceSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc: vpc
    });

    const ec2Instance = new ec2.Instance(this, 'AmazonLinuxInstance', {
      vpc: vpc,
      instanceType: new ec2.InstanceType('t3.micro'),
      machineImage: amazonLinuxAmi,
      role: instanceRole,
      securityGroup: instanceSecurityGroup,
    });
    cdk.Tags.of(ec2Instance).add('Name', 'BatfishSSM');
    // Allow traffic from ALB to EC2 instance on required ports
    for (const portNumber of portNumbers) {
      instanceSecurityGroup.addIngressRule(fargateServiceSecurityGroup, ec2.Port.tcp(portNumber));
    }
  }
}
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class BatfishEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC
    const vpc = new ec2.Vpc(this, 'BatfishVpc', { maxAzs: 3 });
    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, 'BatfishCluster', {
      vpc: vpc,
      containerInsights: true
    });

    // Create Task Definition with Fargate compatibility
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BatfishTaskDefinition', {
      memoryLimitMiB: 8192,
      cpu: 4096,
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
      }
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
      vpc: vpc,
      internetFacing: false
    });
    // Add an ingress rule to allow traffic on port 8888/9996 | Container Port Mappings
    const portNumbers = [9996, 8888];
    const portMappings = [];
    for (const portNumber of portNumbers) {
      portMappings.push({ containerPort: portNumber });
      fargateServiceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(portNumber));
      fargateServiceSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(portNumber));
      loadBalancer.connections.allowFromAnyIpv4(ec2.Port.tcp(portNumber), 'Allow ingress traffic on port ' + portNumber);
      loadBalancer.connections.allowToAnyIpv4(ec2.Port.tcp(portNumber), 'Allow ingress traffic on port ' + portNumber);
    }
    container.addPortMappings(...portMappings);

    const targetGroup9996 = new elbv2.ApplicationTargetGroup(this, 'TargetGroup9996', {
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 9996,
      vpc: vpc,
      stickinessCookieDuration: cdk.Duration.seconds(120),
      healthCheck: {
        path: '/',
        port: "8888",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: "200,302"
      }
    });

    // Group Level Stickiness
    const stickinessDuration = cdk.Duration.seconds(120);

    loadBalancer.addListener('Listener9996', {
      port: 9996,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.weightedForward(
        [{
          targetGroup: targetGroup9996,
          weight: 1
        },],
        {
          stickinessDuration: stickinessDuration,
        }
      )
    });
    // Associate the container tasks with the custom target groups
    fargateService.attachToApplicationTargetGroup(targetGroup9996);

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
      ],
      resources: [
        ssmLogsBucket.bucketArn,
        `${ssmLogsBucket.bucketArn}/*`,
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
      instanceSecurityGroup.addEgressRule(fargateServiceSecurityGroup, ec2.Port.tcp(portNumber));
    }

  }
}

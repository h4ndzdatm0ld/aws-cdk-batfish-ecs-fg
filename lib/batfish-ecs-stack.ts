import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {HealthCheck} from 'aws-cdk-lib/aws-appmesh';
import {open} from 'fs';


export class BatfishEcsStack extends cdk.Stack {
  constructor(scope : Construct, id : string, props? : cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC
    const vpc = new ec2.Vpc(this, 'BatfishVpc', {maxAzs: 3});
    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, 'BatfishCluster', {
      vpc: vpc,
      containerInsights: true
    });

    // Create Task Definition with Fargate compatibility
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BatfishTaskDefinition', {
      memoryLimitMiB: 8192,
      cpu: 2048
    });

    // Add container to the task definition
    const container = taskDefinition.addContainer('BatfishContainer', {
      image: ecs.ContainerImage.fromRegistry('batfish/allinone:latest'),
      logging: ecs.LogDrivers.awsLogs(
        {streamPrefix: 'Batfish'}
      ),
      memoryLimitMiB: 4096,
      cpu: 1024,
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

    // Add necessary ports
    container.addPortMappings({
      containerPort: 9996
    }, {containerPort: 8888});
    
    // Fargate Security Group
    const fargateServiceSecurityGroup = new ec2.SecurityGroup(this, 'FargateServiceSecurityGroup', {
      vpc: vpc,
    });

    // Add an ingress rule to allow traffic on port 8888/9996
    fargateServiceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8888));
    fargateServiceSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8888));
    fargateServiceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9996));
    fargateServiceSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9996));


    // Create a Fargate service
    const fargateService = new ecs.FargateService(this, 'BatfishFargateService', {
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 3,
      assignPublicIp: false,
      vpcSubnets: vpc,
      securityGroups: [fargateServiceSecurityGroup],
    });

    // Create a new Application Load Balancer
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'BatfishLoadBalancer', {
      vpc: vpc,
      internetFacing: true
    });

    const extraIngressPort = 8888;
    loadBalancer.connections.allowFromAnyIpv4(ec2.Port.tcp(extraIngressPort), 'Allow ingress traffic on port ' + extraIngressPort);
    loadBalancer.connections.allowToAnyIpv4(ec2.Port.tcp(extraIngressPort), 'Allow ingress traffic on port ' + extraIngressPort);

    const targetGroup9996 = new elbv2.ApplicationTargetGroup(this, 'TargetGroup9996', {
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 9996,
      vpc: vpc,
      stickinessCookieDuration: cdk.Duration.seconds(60),
      healthCheck: {
        path: '/',
        port: "8888",
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: "200,302"
      }
    });

    loadBalancer.addListener('Listener9996', {
      port: 9996,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.weightedForward(
        [{
            targetGroup: targetGroup9996,
            weight: 1
          },]
      )
    });
    // Associate the container tasks with the custom target groups
    fargateService.attachToApplicationTargetGroup(targetGroup9996);
  }
}

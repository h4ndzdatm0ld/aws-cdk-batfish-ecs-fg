import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BatfishEcsStack } from './batfish-ecs-stack';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import { ArnPrincipal } from 'aws-cdk-lib/aws-iam';
import { AlbTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';


interface Customer {
  name: string;
  arn: string;
}

export class PrivateLinkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, existingStack: BatfishEcsStack, props?: cdk.StackProps) {
    super(scope, id, props);

    // Access the existing VPC and ALB from the provided stack
    const existingVpc = existingStack.vpc;
    const existingLoadBalancer = existingStack.loadBalancer;
    const existingLoadBalancerArn = existingLoadBalancer.loadBalancerArn;

    // Load the YAML file containing the list of customers/ARNs
    const yamlFile = fs.readFileSync('./lib/customers.yml', 'utf8');
    const customers: Customer[] = yaml.load(yamlFile) as Customer[];

    const securityGroup = new ec2.SecurityGroup(this, 'BatfishSecurityGroup', {
      vpc: existingVpc,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9996), 'Allow inbound traffic on port 9996');
    securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), 'Allow all outbound traffic');

    const nlb = new elbv2.NetworkLoadBalancer(this, 'BatfishNLB', {
      loadBalancerName: 'BatfishEndpointServiceNLB',
      vpc: existingVpc,
      internetFacing: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Create the Listener Rule to forward traffic to the Target Group
    const listener = nlb.addListener('BatfishListener', {
      port: 9996,
    });

    listener.addTargets('BatfishTargetGroup', {
      targetGroupName: 'BatfishEndpointTargetGroup',
      targets: [new AlbTarget(existingLoadBalancer, 9996)],
      port: 9996,
      healthCheck: {
        port: '8888',
        path: '/',
      },
    });

    const allowedPrincipals = customers.map((customer) => new ArnPrincipal(customer.arn));

    new ec2.VpcEndpointService(this, 'EndpointService', {
      vpcEndpointServiceLoadBalancers: [nlb],
      acceptanceRequired: false,
      allowedPrincipals: allowedPrincipals,
    });
  }
}

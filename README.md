# Batfish Deployment Infra - AWS CDK - ECS/Fargate/LoadBalancer

Batfish Network Analysis container running in ECS Cluster with Fargate behind a Load Balancer.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Starting Port Forwarding Session to ELB

An example bash script is provided to dynamically grab the instance-id of the EC2 used to tunnel through to the ELB. The ELB is also grabbed dynamically with the AWS CLI toolkit. 

```bash
./ssh-session.sh
```

## Resources

- [SSM Intro](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html)
- [PortForwarding with SSM](https://aws.amazon.com/blogs/aws/new-port-forwarding-using-aws-system-manager-sessions-manager/)

-> Grab Instance ID by TAG 'Name' value of `BatfishSSM`

```bash
INSTANCE_ID=$(aws ec2 describe-instances \
               --filter "Name=tag:Name,Values=BatfishSSM" \
               --query "Reservations[].Instances[?State.Name == 'running'].InstanceId[]" \
               --output text)
```

-> Start StartPortForwardingSessionToRemoteHost through our EC2 Instance to remote ALB on port 9996

```bash
aws ssm start-session \
    --target $INSTANCE_ID \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '{"host":["internal-Batfi-Batfi-1S2SAGIHW8FUA-1303463878.us-west-2.elb.amazonaws.com"],"portNumber":["9996"], "localPortNumber":["9996"]}'
```

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template

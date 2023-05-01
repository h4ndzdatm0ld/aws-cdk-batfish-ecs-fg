#!/bin/bash

# Script Name: ssm-session.sh
# Description: This script retrieves the instance ID of an EC2 instance tagged with a specific name and initiates a
#              port forwarding session from the local machine to the specified private ALB on port 9996.
# Usage:       ./ssm-session.sh
# Examples:    ./ssm-session.sh
# 2023-05-01 05:22:22 - Checking if AWS Session Manager plugin is installed
# 2023-05-01 05:22:22 - AWS Session Manager plugin is installed
# 2023-05-01 05:22:22 - Retrieving Instance ID by TAG 'Name' value of 'BatfishSSM'
# 2023-05-01 05:22:24 - Instance ID retrieved: i-03af63deaeb0438e6
# 2023-05-01 05:22:24 - Retrieving private DNS entry of the private ELB
# 2023-05-01 05:22:25 - Private ELB DNS retrieved: internal-BatfishLoadBalancer-1295843417.us-west-2.elb.amazonaws.com
# 2023-05-01 05:22:25 - Starting port forwarding session to remote ALB on port 9996 in the background
# 2023-05-01 05:22:25 - Port forwarding session started in the background with PID: 782734
# 2023-05-01 05:22:25 - To terminate the session, run: kill 782734


# Exit immediately if a command exits with a non-zero status
set -e

# Function to log messages
log() {
    local message="$1"
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $message"
}

# Step 0: Check if AWS Session Manager plugin is installed
log "Checking if AWS Session Manager plugin is installed"
if ! command -v session-manager-plugin &> /dev/null; then
    log "AWS Session Manager plugin not found"
    read -p "Do you want to install AWS Session Manager plugin for Amazon Linux? (yes/no): " install_choice

    if [[ $install_choice == "yes" ]]; then
        log "Installing AWS Session Manager plugin for Amazon Linux"
        sudo yum install -y https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm \
        || { log "Error: Failed to install AWS Session Manager plugin"; exit 1; }
        log "AWS Session Manager plugin installed successfully"
    else
        log "AWS Session Manager plugin is required for this script to work. Exiting"
        exit 1
    fi
else
    log "AWS Session Manager plugin is installed"
fi

# Step 1: Grab Instance ID by TAG 'Name' value of `BatfishSSM`
log "Retrieving Instance ID by TAG 'Name' value of 'BatfishSSM'"
INSTANCE_ID=$(aws ec2 describe-instances \
               --filter "Name=tag:Name,Values=BatfishSSM" \
               --query "Reservations[].Instances[?State.Name == 'running'].InstanceId[]" \
               --output text) || { log "Error: Failed to retrieve instance ID"; exit 1; }

if [ -z "$INSTANCE_ID" ]; then
    log "Error: Instance with 'Name' tag 'BatfishSSM' not found or is not in 'running' state"
    exit 1
fi

log "Instance ID retrieved: $INSTANCE_ID"

# Step 2: Get the private DNS entry of the private ELB
log "Retrieving private DNS entry of the private ELB"
PRIVATE_ELB_DNS=$(aws elbv2 describe-load-balancers \
                  --query "LoadBalancers[?Scheme == 'internal'].DNSName | [0]" \
                  --output text) || { log "Error: Failed to retrieve private ELB DNS"; exit 1; }

if [ -z "$PRIVATE_ELB_DNS" ]; then
    log "Error: Private ELB DNS not found"
    exit 1
fi

log "Private ELB DNS retrieved: $PRIVATE_ELB_DNS"

# Step 3: Start StartPortForwardingSessionToRemoteHost through our EC2 Instance to remote ALB on port 9996
log "Starting port forwarding session to remote ALB on port 9996 in the background"
SSM_COMMAND='aws ssm start-session \
    --target "'"$INSTANCE_ID"'" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '\''{"host":["'"$PRIVATE_ELB_DNS"'"],"portNumber":["9996"], "localPortNumber":["9996"]}'\'''

eval "$SSM_COMMAND" &> /dev/null &
SSM_PID=$!

log "Port forwarding session started in the background with PID: $SSM_PID"
log "To terminate the session, run: kill $SSM_PID"

#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BatfishEcsStack } from '../lib/batfish-ecs-stack';
import { PrivateLinkStack } from '../lib/private-links-stack';

const app = new cdk.App();
const batfishStack = new BatfishEcsStack(app, 'BatfishEcsStack');
new PrivateLinkStack(app, 'PrivateLinkStack', batfishStack)
app.synth();

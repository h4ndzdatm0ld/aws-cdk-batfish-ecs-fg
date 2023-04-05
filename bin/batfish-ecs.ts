#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BatfishEcsStack } from '../lib/batfish-ecs-stack';

const app = new cdk.App();
new BatfishEcsStack(app, 'BatfishEcsStack');

app.synth();

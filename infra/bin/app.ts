#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ZugsplorationStack } from "../lib/stack";

const app = new cdk.App();

new ZugsplorationStack(app, "Zugsploration", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "eu-central-1",
  },
  crossRegionReferences: true,
});

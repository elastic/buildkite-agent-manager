# Elastic Buildkite Agent Manager

## Overview

## Requirements

- node 16
- A Buildkite API token
- A Buildkite Agent API token

## Getting Started

1. `npm install`
2. `cp .env.template .env`
3. Edit `.env`
4. `npm run start` or `npm run build`

## End User Configuration

### GCP Agents

**name**

- Required
- String
- Name of the agent. Must be unique across agent configurations. GCP instance and Buildkite agent names will be based on this value.
- Example: `agent-name`

**queue**

- Required
- String
- Name of the queue used in Buildkite pipeline definitions to target this configuration. Must be unique across agent configurations.
- Examples: `default`, `my-queue`

**project**

- Required
- String
- GCP Project ID
- Example: `my-cool-gcp-project-1234`

**zones?**

- Required
- String[]
- GCP zones in which to create instances. Will round-robin select one when creating an instance.
- Example: `["us-central1-a", "us-central1-c", "us-central1-f"]`

**imageFamily?**

- Required if `image` is empty
- String
- Specifies the Image Family in GCP to use when creating an instance for this agent. Will use the most recent, non-deprecated image in the family.
- Examples: `my-custom-image-family`, `ubuntu-2004-lts`

**image?**

- Required if `imageFamily` is empty
- String
- Specifies the Image in GCP to use when creating an instance for this agent.
- Example: `my-custom-image-20210101`

**machineType**

- Required
- String
- Specifies the [machine type](https://gcpinstances.doit-intl.com/) to use for the instance. [Custom machine types](https://cloud.google.com/compute/docs/instances/creating-instance-with-custom-machine-type#api) can be used.

**subnetwork**

- Required
- String
- Default: `default`
- The subnetwork in GCP to use when creating the instance.

**disableExternalIp**

- Boolean
- Default: `false`
- When set to `true`, remove the external/public IP when creating the GCP instance.

**serviceAccount**

- Optional
- String
- A service account to attach to the GCP instance when creating.

**serviceAccounts**

- Optional
- String[]
- A list of service accounts to attach to the GCP instance when creating.

**diskType**

- Required
- `'pd-ssd' | 'pd-balanced' | 'pd-standard'`
- The disk type to attach to the instance for the root partition.

**diskSizeGb**

- Required
- Number
- The size in gigabytes for the root disk.

**localSsds**

- Optional
- Number
- The number of local SSDs to attach to the instance. Always uses NVMe currently.

The local SSDs must be prepared before use, for example, using a startup script.

```bash
{
  if [[ -e /dev/nvme0n1 ]]; then
    echo "Setting up Local SSD..."
    mkfs.ext4 -F /dev/nvme0n1
    mkdir -p /opt/local-ssd
    mount -o discard,defaults,nobarrier,noatime /dev/nvme0n1 /opt/local-ssd
    chmod a+w /opt/local-ssd
    mkdir /opt/local-ssd/buildkite
    chown buildkite-agent:buildkite-agent /opt/local-ssd/buildkite
    echo 'build-path="/opt/local-ssd/buildkite/builds"' >> /etc/buildkite-agent/buildkite-agent.cfg
  fi
}
```

**overprovision**

- Optional
- Integer > 0 or Decimal < 1
- Overprovision the agents by this amount. A constant amount if configured as a positive integer. A percentage is configured as a decimal less than 1.

For example, if 100 agents are currently needed to fulfill running jobs in Buildkite:

`overprovision: 10` means 110 agents will be created.

`overprovision: 0.5` means overprovision by 50%, e.g. 150 agents will be created.

**minimumAgents**

- Optional
- Number
- The minimum number of agents that should be online for this type at all times.

**maximumAgents**

- Optional
- Number
- The maximum number of agents that should be online for this agent type at a time. If more agents than this are required to fulfill the current jobs in Buildkite, the jobs will wait.

**idleTimeoutMins**

- Optional
- Number
- If the agent doesn't run any jobs for the specified number of minutes, Buildkite will gracefully disconnect the agent.

**exitAfterOneJob**

- Optional
- Boolean
- Default: `false`
- If true, the Buildkite agent will run a single job, and then disconnect.

**gracefulStopAfterMins**

- Optional
- Number
- If the agent is online for more than the specified time, the agent manager will issue a `stop` command to the agent. This will cause Buildkite to gracefully disconnect the agent after it finishes its current job.

**hardStopAfterMins**

- Optional
- Number
- If the GCP instance is online for more than the specified time, it will be terminated and deleted. Would typically be combined with `gracefulStopAfterMins`.

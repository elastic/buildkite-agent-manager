const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const GCP_SECRET_MAPPING = {
  GITHUB_TOKEN: 'kibana-jenkins-pr-bot-github-token',
  WEBHOOK_SECRET: 'kibana-jenkins-pr-bot-webhook-secret',
  JENKINS_USERNAME: 'kibana-jenkins-pr-bot-jenkins-username',
  JENKINS_TOKEN: 'kibana-jenkins-pr-bot-jenkins-token',
};

const getSecret = async (client, id) => {
  const [accessResponse] = await client.accessSecretVersion({
    name: `projects/261553193300/secrets/${id}/versions/latest`,
  });

  return accessResponse?.payload?.data?.toString();
};

export default async () => {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const client = new SecretManagerServiceClient();
  const envVars = Object.keys(GCP_SECRET_MAPPING).filter((key) => !(key in process.env));

  try {
    const values = await Promise.all(envVars.map((key) => getSecret(client, GCP_SECRET_MAPPING[key])));

    for (let i = 0; i < envVars.length; i++) {
      process.env[envVars[i]] = values[i];
    }
  } catch (ex) {
    console.error('Error bootstrapping secrets from GCP', ex);
    process.exit(1);
  }
};

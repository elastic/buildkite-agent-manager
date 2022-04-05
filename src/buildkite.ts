import axios, { AxiosInstance } from 'axios';
import { request, gql, GraphQLClient } from 'graphql-request';
import logger from './lib/logger';
import parseLinkHeader from './lib/parseLinkHeader';

export interface AgentMetrics {
  agents: { idle: number; busy: number; total: number };
  jobs: { scheduled: number; running: number; waiting: number; total: number };
  organization: { slug: string };
}

export interface AgentsResponse {
  organization: {
    agents: {
      count: number;
      pageInfo: {
        endCursor: string;
        startCursor: string;
        hasNextPage: boolean;
      };
      edges: [{ node: Agent }];
    };
  };
}

export interface Agent {
  id: string;
  uuid: string;
  name: string;
  connectionState: string;
  createdAt: string;
  metaData: string[];
}

export class Buildkite {
  http: AxiosInstance;
  agentHttp: AxiosInstance;
  graphql: GraphQLClient;

  constructor() {
    const BUILDKITE_BASE_URL = process.env.BUILDKITE_BASE_URL || 'https://api.buildkite.com';
    const BUILDKITE_TOKEN = process.env.BUILDKITE_TOKEN;

    const BUILDKITE_AGENT_BASE_URL = process.env.BUILDKITE_AGENT_BASE_URL || 'https://agent.buildkite.com/v3';
    const BUILDKITE_AGENT_TOKEN = process.env.BUILDKITE_AGENT_TOKEN;

    const BUILDKITE_GRAPHQL_URL = process.env.BUILDKITE_GRAPHQL_URL || 'https://graphql.buildkite.com/v1';
    const BUILDKITE_GRAPHQL_TOKEN = process.env.BUILDKITE_GRAPHQL_TOKEN || process.env.BUILDKITE_TOKEN;

    this.http = axios.create({
      baseURL: BUILDKITE_BASE_URL,
      headers: {
        Authorization: `Bearer ${BUILDKITE_TOKEN}`,
      },
    });

    this.agentHttp = axios.create({
      baseURL: BUILDKITE_AGENT_BASE_URL,
      headers: {
        Authorization: `Token ${BUILDKITE_AGENT_TOKEN}`,
      },
    });

    this.graphql = new GraphQLClient(BUILDKITE_GRAPHQL_URL, {
      headers: {
        authorization: `Bearer ${BUILDKITE_GRAPHQL_TOKEN}`,
      },
    });
  }

  getAgents = async (): Promise<Agent[]> => {
    logger.info('[buildkite] Getting all agents');

    const agentPages: Agent[][] = [];
    let nextCursor: string = null;
    let totalCount: number = null;
    // Don't get stuck in an infinite loop or follow more than 50 pages
    for (let i = 0; i < 10; i++) {
      const nextStr = nextCursor ? `, after:"${nextCursor}"` : '';
      const request = gql`
        {
          organization(slug: "elastic") {
            agents(first: 500, metaData:["agent-manager=${process.env.AGENT_MANAGER_NAME || 'kibana'}"], isRunningJob:true${nextStr}) {
              count
              pageInfo {
                endCursor
                startCursor
                hasNextPage
              }
              edges {
                node {
                  createdAt
                  name
                  id
                  uuid
                  connectionState
                  metaData
                }
              }
            }
          }
        }
      `;

      const data = await this.graphql.request<AgentsResponse>(request);
      totalCount = totalCount ?? data.organization.agents.count;
      agentPages.push(data.organization.agents.edges.map(({ node }) => node));
      if (!data.organization.agents.pageInfo.hasNextPage) {
        break;
      }

      nextCursor = data.organization.agents.pageInfo.endCursor;
    }

    logger.info('[buildkite] Finished getting all agents');

    return agentPages.flat();
  };

  getAgentMetrics = async (queue: string) => {
    return (await this.agentHttp.get(`metrics/queue?name=${encodeURIComponent(queue)}`)).data as AgentMetrics;
  };

  getAllAgentMetrics = async () => {
    return (await this.agentHttp.get(`metrics`)).data;
  };

  stopAgent = async (agent: Agent) => {
    if (!process.env.DRY_RUN) {
      return await this.http.put(`v2/organizations/elastic/agents/${agent.uuid}/stop`, { force: false });
    } else {
      logger.info(`[buildkite] would stop ${agent.uuid} / ${agent.name}`);
    }
  };
}

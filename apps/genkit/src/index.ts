import { enableFirebaseTelemetry } from '@genkit-ai/firebase';
import { googleAI } from '@genkit-ai/googleai';
import { defineSecret } from 'firebase-functions/params';
import { onCallGenkit } from 'firebase-functions/v2/https';
import { genkit, z } from 'genkit';

enableFirebaseTelemetry();

const githubToken = defineSecret('GITHUB_TOKEN');
const geminiApiKey = defineSecret('GEMINI_API_KEY');

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-2.5-flash'),
});

const workflowSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  url: z.string(),
  html_url: z.string(),
  badge_url: z.string(),
});

const workflowRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  workflow_id: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  run_started_at: z.string().nullable(),
  html_url: z.string(),
});

const workflowsResponseSchema = z.object({
  total_count: z.number(),
  workflows: z.array(workflowSchema),
});

const workflowRunsResponseSchema = z.object({
  total_count: z.number(),
  workflow_runs: z.array(workflowRunSchema),
});

const fetchWorkflows = ai.defineTool(
  {
    name: 'fetchWorkflows',
    description:
      'Fetches all GitHub Actions workflows for a given repository (owner/repo).',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
    outputSchema: z.array(workflowSchema),
  },
  async ({ owner, repo }) => {
    console.log(`Fetching workflows for ${owner}/${repo}`);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Workflow-Health-Checker',
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch workflows from GitHub: ${response.statusText}`,
      );
    }

    const data = await response.json();
    const parsed = workflowsResponseSchema.parse(data);

    return parsed.workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
      created_at: workflow.created_at,
      updated_at: workflow.updated_at,
      url: workflow.url,
      html_url: workflow.html_url,
      badge_url: workflow.badge_url,
    }));
  },
);

const fetchWorkflowRuns = ai.defineTool(
  {
    name: 'fetchWorkflowRuns',
    description:
      'Fetches the run history for a specific workflow to analyze success/failure patterns.',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      workflowId: z.number(),
    }),
    outputSchema: z.array(workflowRunSchema),
  },
  async ({ owner, repo, workflowId }) => {
    console.log(`Fetching runs for workflow ${workflowId} in ${owner}/${repo}`);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Workflow-Health-Checker',
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch workflow runs from GitHub: ${response.statusText}`,
      );
    }

    const data = await response.json();
    const parsed = workflowRunsResponseSchema.parse(data);

    return parsed.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      workflow_id: run.workflow_id,
      created_at: run.created_at,
      updated_at: run.updated_at,
      run_started_at: run.run_started_at,
      html_url: run.html_url,
    }));
  },
);

const workflowHealthFlow = ai.defineFlow(
  {
    name: 'workflowHealthFlow',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
    outputSchema: z.string(),
  },
  async ({ owner, repo }, streamCallback) => {
    const { response, stream } = ai.generateStream({
      prompt: `
          You are an expert DevOps engineer and reliability analyst specializing in CI/CD pipeline health assessment.
          
          Your task is to analyze GitHub Actions workflows for the repository "${owner}/${repo}" and provide a comprehensive health report.

          Using the provided tools:
          1. Fetch all workflows for the repository
          2. For each workflow, fetch its recent run history (up to 100 runs)
          3. Analyze the patterns to assess workflow health
          
          For each workflow, provide:
          - **Workflow Name**
          - **Status**: Calculate as a percentage based on predicted future success rate:
            * 80-100% = "Healthy" (represented by green circle badge)
            * 50-79% = "Need Improvement" (represented by yellow circle badge)
            * 0-49% = "At Risk" (represented by red circle badge)
          - **File Path**
          - **Last Updated**: Date of last workflow update
          - **Total Runs**: Total number of workflow runs in the history
          - **Successful Runs**: Count of successful completions
          - **Failed Runs**: Count of failures
          - **Success Rate**: Percentage of successful runs (calculated)
          - **Quick Summary**: A 2-3 line AI-generated summary highlighting:
            * Recent trends (improving/degrading)
            * Key issues if any (consistent failures, timeout patterns, specific branches)
            * Recommendations for improvement if needed
          
          Consider these factors for health prediction:
          - Recent success/failure patterns (weight recent runs more heavily)
          - Consistency of outcomes
          - Time-based trends (getting better or worse)
          - Failure clustering (multiple failures in sequence indicate instability)
          
          Return the analysis in a clear, structured JSON format that can be easily parsed and displayed in a UI.
          
          Format:
          {
            "workflows": [
              {
                "name": "Workflow Name",
                "status": "Healthy|Need Improvement|At Risk",
                "statusPercentage": 85,
                "filePath": ".github/workflows/ci.yml",
                "lastUpdated": "2024-01-15T10:30:00Z",
                "totalRuns": 150,
                "successfulRuns": 145,
                "failedRuns": 5,
                "successRate": 96.7,
                "summary": "Workflow is highly reliable with consistent success over the past 30 days. Recent trend shows improvement in build times. No critical issues detected."
              }
            ]
          }
      `,
      tools: [fetchWorkflows, fetchWorkflowRuns],
      config: {
        temperature: 0.3,
      },
    });

    for await (const chunk of stream) {
      streamCallback(chunk);
    }

    const { text } = await response;
    console.log({ text });

    return text;
  },
);

export const workflowHealthFunction = onCallGenkit(
  {
    secrets: [githubToken, geminiApiKey],
    cors: {
      origin: ['http://localhost:4200', 'https://github-griller.web.app'],
    },
  },
  workflowHealthFlow,
);

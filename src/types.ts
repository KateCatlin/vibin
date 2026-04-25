export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'error';

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  source: 'scanner' | 'ai' | 'browser' | 'dependency';
  file?: string;
  line?: number;
  evidence?: string;
  suggestion: string;
}

export interface ReportSection {
  title: string;
  body: string;
}

export interface CheckResult {
  name: 'security' | 'ui' | 'users' | 'check';
  status: CheckStatus;
  summary: string;
  findings: Finding[];
  sections: ReportSection[];
  startedAt: string;
  completedAt: string;
}

export interface RunContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AiRequest {
  system: string;
  prompt: string;
  preferJson?: boolean;
}

export interface AiResponse {
  text: string;
  provider: string;
}

export interface AiProvider {
  name: string;
  generateText(request: AiRequest): Promise<AiResponse>;
}

export interface CommonOutputOptions {
  output?: string;
}

export interface BrowserTargetOptions {
  cwd: string;
  url?: string;
  startCommand?: string;
  timeoutMs?: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  interactiveElements: string[];
  consoleErrors: string[];
  brokenImages: number;
  screenshotPath?: string;
}

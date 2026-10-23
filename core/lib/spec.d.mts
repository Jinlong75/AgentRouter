// spec.mjs 的类型声明（软件新建任务页用 TypeScript 引入 mergeSpec 算门禁）。
export interface SpecInput {
    type?: string;
    allowed_paths?: string[];
    verify?: string[];
    expect_commit?: boolean;
    timeout_min?: number;
    verify_timeout_min?: number;
    max_retries?: number;
    [key: string]: unknown;
}
export interface ProjectGateConfig {
    allowedPaths?: string[];
    verify?: string[];
    verifyTimeoutMin?: number;
    maxRetries?: number;
    [key: string]: unknown;
}
export interface MergedSpec {
    allowed_paths: string[];
    verify: string[];
    expect_commit: boolean;
    timeout_min: number;
    verify_timeout_min: number;
    max_retries: number;
    gate: boolean;
}
export declare function mergeSpec(spec?: SpecInput, project?: ProjectGateConfig): MergedSpec;

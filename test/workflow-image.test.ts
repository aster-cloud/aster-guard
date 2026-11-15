import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// 镜像工作流守卫（aster-api ADR 0054 §12 D5）：签名身份只能来自 main 上的本工作流，PR 不能触发；
// id-token 只在 build job；cosign 版本固定；k3s pin 走 Environment image-pin；每个镜像先校验 arm64 再签名。

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = parse(read('.github/workflows/image.yml')) as Workflow;
const IMAGES = ['docker.io/wontlost/aster-guard-mcp', 'docker.io/wontlost/aster-guard-demo-tool'];
const IDENTITY = 'https://github.com/aster-cloud/aster-guard/.github/workflows/image.yml@refs/heads/main';

describe('image.yml', () => {
  it('imageWorkflowHasNoPullRequestTrigger', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push).toEqual({ branches: ['main'] });
  });

  it('idTokenOnlyOnBuildJob', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === 'build') {
        expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
      } else {
        expect(job.permissions?.['id-token'], name).toBeUndefined();
      }
    }
    expect(workflow.jobs.build.if).toContain("github.ref == 'refs/heads/main'");
  });

  it('cosignVersionPinned', () => {
    const installers = workflow.jobs.build.steps.filter((s) => s.uses?.startsWith('sigstore/cosign-installer@'));
    expect(installers).toHaveLength(1);
    expect(installers[0].uses).toMatch(/^sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6$/);
    expect(installers[0].with?.['cosign-release']).toBe('v2.5.2');
  });

  it('imagePinJobUsesEnvironment', () => {
    const pin = workflow.jobs['image-pin-pr'];
    expect(pin.environment).toBe('image-pin');
    expect(pin.needs).toBe('build');
    expect(pin.if).toContain("github.ref == 'refs/heads/main'");
    const opens = pin.steps.filter((s) => s.run?.includes('scripts/ci/open-image-pin-pr.sh'));
    expect(opens.map((s) => [s.env?.LOCK_PATH, s.env?.KUSTOMIZATION_PATH])).toEqual([
      ['apps/aster-lang/guard/image-lock.yaml', 'apps/aster-lang/guard/kustomization.yaml'],
      ['apps/aster-lang/tools/image-lock.yaml', 'apps/aster-lang/tools/kustomization.yaml'],
    ]);
    expect(opens[0].run).toContain(`${IMAGES[0]} image-pin/aster-guard-mcp`);
    expect(opens[1].run).toContain(`${IMAGES[1]} image-pin/aster-guard-demo-tool`);
    const guard = workflow.jobs['pin-closure-guard'];
    expect(guard.if).toBe('always()');
    expect(guard.steps.some((s) => s.run === 'bash scripts/ci/pin-closure-guard.sh')).toBe(true);
  });

  it('bothImagesAreArchVerifiedBeforeSigning', () => {
    const steps = workflow.jobs.build.steps;
    const index = (pred: (s: Step) => boolean, label: string) => {
      const i = steps.findIndex(pred);
      expect(i, label).toBeGreaterThanOrEqual(0);
      return i;
    };
    for (const [key, file] of [
      ['mcp', 'docker/mcp.Dockerfile'],
      ['tool', 'docker/demo-tool.Dockerfile'],
    ] as const) {
      const push = index((s) => s.uses?.startsWith('docker/build-push-action@') === true && s.with?.file === file, `push ${key}`);
      const build = steps[push];
      expect(build.with?.platforms).toBe('linux/arm64');
      expect(build.with?.provenance).toBe(false);
      expect(build.with?.push).toBe(true);
      const arch = index((s) => s.run?.includes('uname -m') === true && s.env?.DIGEST === `\${{ steps.${build.id}.outputs.digest }}`, `arch ${key}`);
      const sign = index((s) => s.run?.includes('cosign sign') === true && s.env?.DIGEST === `\${{ steps.${build.id}.outputs.digest }}`, `sign ${key}`);
      const verify = index((s) => s.run?.includes('cosign verify') === true && s.env?.DIGEST === `\${{ steps.${build.id}.outputs.digest }}`, `verify ${key}`);
      expect(push).toBeLessThan(arch);
      expect(arch).toBeLessThan(sign);
      expect(sign).toBeLessThan(verify);
      expect(steps[verify].run).toContain(`--certificate-identity "${IDENTITY}"`);
      expect(steps[verify].run).toContain('--certificate-oidc-issuer "https://token.actions.githubusercontent.com"');
    }
  });
});

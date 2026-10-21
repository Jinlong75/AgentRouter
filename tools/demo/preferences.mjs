import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPlan, executePlan, skills } from '../../installer/lib/install.mjs';
import { homeEnv, testAgentEnv } from '../../core/lib/compat.mjs';

// install：true 装全部技能，false 不装，数组只装列出的技能（逐个分批）。
export async function preferenceFixture(home, { install = true } = {}) {
  const user = path.join(home, 'user'), appdata = path.join(user,'AppData','Roaming');
  // 先清掉继承来的相关变量（含新旧两种名字），再写入隔离值。
  const env = { ...process.env };
  for(const key of ['CODEX_MODEL','CODEX_EFFORT','CODEX_TIER','CODEX_SANDBOX','CODEX_NO_WATCH','AR_NO_WATCH','AR_PROFILE','AR_TEST_SECRETS_FILE',...homeEnv,...testAgentEnv]) delete env[key];
  // 用户真实的密钥变量一律不带进隔离环境：验收结果与这台电脑有没有设置密钥无关，也绝不会用到真实密钥。
  for(const key of Object.keys(env)) if(/_API_KEY$|_AUTH_TOKEN$|_OAUTH_TOKEN$/i.test(key)) delete env[key];
  // TEMP/TMP 也放进隔离目录：清除缓存与重置的"残留标记"只碰临时公共目录，绝不写用户真实的系统临时目录。
  const temp = path.join(home,'tmp');
  Object.assign(env, { AGENT_ROUTER_HOME: home, USERPROFILE: user, HOME: user, APPDATA: appdata,
    CLAUDE_CONFIG_DIR: path.join(user,'.claude'), CODEX_HOME: path.join(user,'.codex'), XDG_CONFIG_HOME: path.join(user,'.config'),
    AR_TEST_AGENT: path.join(home,'fake-codex.cjs'), AR_TEST_SECRETS_FILE: path.join(home,'secrets-test.json'),
    TEMP: temp, TMP: temp,
    // git 的全局配置也放进隔离目录：验收绝不读写用户真实的 ~/.gitconfig，"没有提交身份"也能稳定复现。
    GIT_CONFIG_GLOBAL: path.join(home,'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
  // 所有检测与安装都在同一个隔离目录，绝不回落到真实 PATH 或宿主。
  env.CODEX_TIER='priority';
  for(const dir of [env.CLAUDE_CONFIG_DIR,env.CODEX_HOME,temp]) await mkdir(dir,{recursive:true});
  await writeFile(env.GIT_CONFIG_GLOBAL,'');
  await writeFile(path.join(env.CODEX_HOME,'config.toml'),'model = "gpt-x"\nmodel_reasoning_effort = "medium"\nservice_tier = "default"\n');
  await writeFile(env.AR_TEST_AGENT,`const fs=require('node:fs');const path=require('node:path');const state=JSON.parse(fs.readFileSync(path.join(__dirname,'fake-codex.json'),'utf8'));if(state.missing)process.exit(1);if(process.argv.includes('--version')){console.log(state.version);process.exit(0);}if(process.argv.slice(-2).join(' ')==='login status'){console.error(state.loggedIn?'Logged in using ChatGPT':'Not logged in');process.exit(state.loggedIn?0:1);}if(process.argv.includes('-p')&&process.argv.includes('stream-json')){process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK'}));process.exit(0);});return;}process.exit(2);\n`);
  await writeFile(path.join(home,'fake-codex.json'),JSON.stringify({version:'codex-cli 0.156.1',loggedIn:true}));
  // 假 Claude Code（037 第 4 项）：AR_TEST_AGENT 这个假脚本对所有适配器跑同一份、版本是 codex 的，
  // claude-code 执行者的版本会串成 codex-cli。真实安装没有这个问题（detect 跑的是真 claude --version）。
  // 给 claude-code 的 profile 配上 path 指向这里（path 优先于 AR_TEST_AGENT，见 core/adapters 的 resolveLauncher），版本就是 Claude Code 风格。
  await writeFile(path.join(home,'fake-claude.cjs'),`const VERSION='2.1.302 (Claude Code)';if(process.argv.includes('--version')){console.log(VERSION);process.exit(0);}if(process.argv.includes('-p')&&process.argv.includes('stream-json')){process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK'}));process.exit(0);});return;}process.exit(2);\n`);
  if (install === true) executePlan(createPlan({env,host:'claude-code'}),{env});
  else if (Array.isArray(install)) for (const skill of install.filter(s => skills.includes(s))) executePlan(createPlan({env,host:'claude-code',skill}),{env});
  return env;
}

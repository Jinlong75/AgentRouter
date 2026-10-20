import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreferences, loginState, skillState, hostActions, defaultChecked } from '../../app/src/main/preferences.mjs';
import { preferenceFixture } from '../../tools/demo/preferences.mjs';
import { copyFont, copyBrandFont, checkBrandFont, brandFontHash } from '../../tools/fonts.mjs';
import { ico, sizes } from '../../tools/icons.mjs';
import { runInstaller } from '../../installer/cli.mjs';
import { uninstall } from '../../installer/lib/install.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
async function fixture(t) {
  const home=await mkdtemp(path.join(os.tmpdir(),'dispatchdock-preferences-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const env=await preferenceFixture(home);
  return {home,env,service:await createPreferences(root,path.join(home,'monitor'),env)};
}
test('配置即时写入、保留未知字段、显示环境覆盖和 Codex 当前配置',async t=>{
  const {home,service}=await fixture(t);
  await writeFile(path.join(home,'config.json'),JSON.stringify({v:1,extension:{keep:true},agents:{other:{keep:1},codex:{future:'value'}}}));
  const result=await service.run('save',{key:'model',value:'custom-model'});
  assert.equal(result.values.model,'custom-model');assert.equal(result.current.model,'gpt-x');assert.deepEqual(result.overrides.tier,{name:'CODEX_TIER',value:'priority'});
  const disk=JSON.parse(await readFile(path.join(home,'config.json'),'utf8'));
  assert.deepEqual(disk.extension,{keep:true});assert.equal(disk.profiles.codex.future,'value');assert.equal(disk.agents.other.keep,1);assert.equal(disk.v,2);
  await service.run('save',{key:'model',value:null});assert.equal((await service.run('settings')).values.model,null);
  await service.run('save',{key:'watchWindow',value:'never'});assert.equal(JSON.parse(await readFile(path.join(home,'config.json'),'utf8')).watchWindow,'never');
});

test('配置路径按用户目录、Windows APPDATA 和其他完整路径显示',async t=>{
  const {home,env,service}=await fixture(t);
  assert.equal((await service.run('settings')).file,path.join(home,'config.json'));
  for(const [base,expected] of [
    [path.join(env.HOME,'config'),'~/config/config.json'],
    [path.join(env.APPDATA,'agent-router'),process.platform==='win32'?'%APPDATA%\\agent-router\\config.json':'~/AppData/Roaming/agent-router/config.json'],
    [env.HOME+'-other',path.join(env.HOME+'-other','config.json')]
  ]) {
    const other=await createPreferences(root,path.join(home,'monitor'),{...env,AGENT_ROUTER_HOME:base});
    assert.equal((await other.run('settings')).file,expected);
  }
});

test('托管开关默认关闭、即时保存且只接受布尔值',async t=>{
  const {home,service}=await fixture(t);
  assert.equal((await service.run('settings')).managed,false);
  assert.equal((await service.run('save',{key:'managed',value:true})).managed,true);
  assert.equal(JSON.parse(await readFile(path.join(home,'config.json'),'utf8')).managed,true);
  await assert.rejects(service.run('save',{key:'managed',value:'false'}));
  assert.equal((await service.run('settings')).managed,true);
  assert.equal((await service.run('save',{key:'managed',value:false})).managed,false);
  await writeFile(path.join(home,'config.json'),JSON.stringify({v:1,managed:'true'}));
  assert.match((await service.run('settings')).reason,/managed/);
});
test('无效 JSON、版本和字段拒绝写入；失败不篡改文件',async t=>{
  const {home,service}=await fixture(t),file=path.join(home,'config.json');
  for(const content of ['invalid','{"v":3}','{"v":1,"agents":{"codex":{"model":3}}}']) {
    await writeFile(file,content);assert.ok((await service.run('settings')).reason);
    await assert.rejects(service.run('save',{key:'tier',value:'priority'}));assert.equal(await readFile(file,'utf8'),content);
  }
  await rm(file);await mkdir(file);
  await assert.rejects(service.run('save',{key:'model',value:'new'}));
});
test('应用偏好独立保存，引导跳过不创建配置、完成创建默认配置且重跑不重写',async t=>{
  const {home,env,service}=await fixture(t),file=path.join(home,'config.json');
  assert.equal((await service.run('settings')).own.notifications,true);
  await service.run('own',{key:'notifications',value:false});await service.run('own',{key:'theme',value:'light'});
  await service.run('finish',{configure:false});assert.equal((await service.run('settings')).exists,false);
  await service.run('finish',{configure:true});const content=await readFile(file,'utf8');assert.equal(JSON.parse(content).profiles.codex.model,null);
  await service.run('finish',{configure:true});assert.equal(await readFile(file,'utf8'),content);
  const restored=await createPreferences(root,path.join(home,'monitor'),env);
  // closeAction / trayHintShown 是 012 新增的窗口偏好，默认值与其它字段一起持久化。
  assert.deepEqual((await restored.run('settings')).own,{notifications:false,theme:'light',wizardDone:true,closeAction:'ask',trayHintShown:false});
});
test('连接状态、按钮组合、引导默认选择与批次隔离',async t=>{
  const {home,env,service}=await fixture(t);
  let data=await service.run('detect');const cc=data.hosts[0];assert.equal(data.hosts.length,1);
  assert.deepEqual(cc.skills.map(s=>s.state),['latest','latest']);assert.ok(cc.actions.includes('reinstall'));assert.ok(cc.actions.includes('rollback'));assert.equal(cc.skills[0].checked,false);
  uninstall({env,host:'claude-code',skill:'lead-workflow'});
  data=await service.run('detect');assert.ok(data.hosts[0].actions.includes('install'));assert.equal(data.hosts[0].skills[1].state,'missing');assert.equal(data.hosts[0].skills[1].checked,true);
  assert.ok(cc.root.startsWith('~'));assert.equal(data.codex.login,'in');
  const marker=path.join(env.CLAUDE_CONFIG_DIR,'skills','agent-router','.agent-router.json');
  const original=await readFile(marker,'utf8');await rm(marker);
  data=await service.run('detect');assert.equal(data.hosts[0].skills[0].state,'custom');assert.equal(data.hosts[0].skills[0].checked,false);
  await service.run('install',{host:'claude-code',operation:'update'});await assert.rejects(readFile(marker));
  await service.run('install',{host:'claude-code',operation:'replace',skills:['agent-router']});
  assert.equal((await service.run('detect')).hosts[0].skills[0].state,'latest');
  await service.run('install',{host:'claude-code',operation:'rollback'});await assert.rejects(readFile(marker));
  assert.equal((await service.run('detect')).hosts[0].skills[1].state,'missing');
  await writeFile(marker,JSON.stringify({...JSON.parse(original),version:'0.0.0'}));
  assert.equal((await service.run('detect')).hosts[0].skills[0].state,'update');
  await service.run('install',{host:'claude-code',operation:'update'});assert.equal((await service.run('detect')).hosts[0].skills[0].state,'latest');
  await assert.rejects(service.run('install',{host:'unknown',operation:'install'}));
  await assert.rejects(service.run('save',{key:'managed',value:'true'}));
  assert.equal((await service.run('settings')).exists,false);
});
test('宿主卡片找到该宿主最近备份，撤销后可以重做',async t=>{
  const {service}=await fixture(t);
  await service.run('install',{host:'claude-code',operation:'rollback'});
  let data=await service.run('detect');assert.deepEqual(data.hosts[0].skills.map(s=>s.state),['missing','missing']);
  await service.run('install',{host:'claude-code',operation:'rollback'});
  data=await service.run('detect');assert.deepEqual(data.hosts[0].skills.map(s=>s.state),['latest','latest']);
});
test('按钮组合覆盖混合状态，未知或手装版本受保护',()=>{
  assert.equal(skillState({state:'foreign'},'0.1.0'),'custom');assert.equal(skillState({state:'modified'},'0.1.0'),'custom');
  assert.equal(skillState({state:'owned',version:'1.0.0'},'0.1.0'),'newer');
  assert.deepEqual(hostActions([{state:'custom'},{state:'missing'}],true),['install','rollback','replace']);
  assert.deepEqual(hostActions([{state:'update'},{state:'missing'}],false),['install','update']);
  assert.deepEqual(['missing','update','custom','latest','newer'].map(defaultChecked),[true,true,false,false,false]);
  assert.deepEqual(hostActions([{state:'newer'},{state:'latest'}],false),[]);
});
test('Codex 指定入口优先、版本提示持久化、清除后不再提示',async t=>{
  const {home,env,service}=await fixture(t);
  await service.run('detect');
  await writeFile(path.join(home,'fake-codex.json'),JSON.stringify({version:'codex-cli 0.157.0',loggedIn:false}));
  let data=await service.run('detect');assert.equal(data.codex.login,'out');assert.deepEqual(data.codex.change,{old:'codex-cli 0.156.1',next:'codex-cli 0.157.0'});
  const restored=await createPreferences(root,path.join(home,'monitor'),env);assert.ok((await restored.run('detect')).codex.change);
  await restored.run('ack');assert.equal((await restored.run('detect')).codex.change,null);
  const other=path.join(home,'other.cjs');await writeFile(other,'console.log("codex-cli 0.158.0");');
  await service.run('save',{key:'path',value:other});data=await service.run('detect');assert.equal(data.codex.version,'codex-cli 0.158.0');assert.equal(data.codex.login,'unknown');
  await service.run('save',{key:'path',value:null});assert.equal((await service.run('detect')).codex.version,'codex-cli 0.157.0');
  await writeFile(path.join(home,'fake-codex.json'),JSON.stringify({missing:true}));assert.equal((await service.run('detect')).codex.installed,false);
});
test('登录状态不依赖账号，不把普通退出错误当成未登录',()=>{
  assert.equal(loginState({status:0,stderr:'Logged in using ChatGPT'}),'in');
  assert.equal(loginState({status:0,stderr:'Logged in using an API key - [redacted]'}),'in');
  assert.equal(loginState({status:1,stderr:'Not logged in'}),'out');
  assert.equal(loginState({status:1,stderr:'permission denied'}),'unknown');
  assert.equal(loginState({status:0,stderr:'Not logged in'}),'unknown');
  assert.equal(loginState({status:null,error:Error('timeout')}),'unknown');
});
test('字体缺失或校验不符时构建步骤继续，移除旧产物避免误用',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'dispatchdock-font-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const out=path.join(dir,'dist'),font=path.join(dir,'font.ttf');await mkdir(path.join(out,'fonts'),{recursive:true});await writeFile(path.join(out,'fonts','MiSansVF.ttf'),'stale');
  assert.equal(await copyFont(out,font),false);await assert.rejects(readFile(path.join(out,'fonts','MiSansVF.ttf')));
  await writeFile(font,'invalid');assert.equal(await copyFont(out,font),false);
});
test('ICO 头部、九个尺寸、偏移和嵌入 PNG 完整',()=>{
  const images=sizes.map(size=>({size,png:Buffer.from([137,80,78,71,13,10,26,10,size%256])})),bytes=ico(images);
  assert.equal(bytes.readUInt16LE(0),0);assert.equal(bytes.readUInt16LE(2),1);assert.equal(bytes.readUInt16LE(4),9);
  let offset=6+16*9;
  images.forEach(({size,png},i)=>{const at=6+16*i;assert.equal(bytes[at],size%256);assert.equal(bytes[at+1],size%256);assert.equal(bytes.readUInt16LE(at+4),1);assert.equal(bytes.readUInt16LE(at+6),32);assert.equal(bytes.readUInt32LE(at+12),offset);assert.equal(bytes.readUInt32LE(at+8),png.length);assert.deepEqual(bytes.subarray(offset,offset+png.length),png);offset+=png.length;});
  assert.equal(offset,bytes.length);
});
test('首次安装只提示撤销命令，有原版本时说明备份',async t=>{
  const {env}=await fixture(t);const lines=[];
  uninstall({env,host:'claude-code',skill:'lead-workflow'});
  await runInstaller(['--host','claude-code','--skill','lead-workflow','--yes'],{env,output:s=>lines.push(s)});
  assert.ok(lines.some(l=>l==='要撤销这次安装：node installer/install.mjs --rollback'));assert.ok(!lines.some(l=>l.startsWith('原来的版本已备份到')));
  lines.length=0;await runInstaller(['--host','claude-code','--skill','lead-workflow','--yes'],{env,output:s=>lines.push(s)});assert.ok(lines.some(l=>l.startsWith('原来的版本已备份到')));
});
test('字标字体 Space Grotesk 缺失或校验不符时构建继续、移除旧产物；哈希固定为核实值',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentrouter-brand-font-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const out=path.join(dir,'dist'),font=path.join(dir,'brand.ttf');await mkdir(path.join(out,'fonts'),{recursive:true});await writeFile(path.join(out,'fonts','SpaceGrotesk.ttf'),'stale');
  assert.equal(await copyBrandFont(out,font),false);await assert.rejects(readFile(path.join(out,'fonts','SpaceGrotesk.ttf')));
  await writeFile(font,'invalid');assert.equal(await copyBrandFont(out,font),false);await assert.rejects(checkBrandFont(font),/SHA-256/);
  assert.equal(brandFontHash,'acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72');
});

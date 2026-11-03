import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesWaiter } from '../../tools/shots.mjs';

const script='C:\\project\\app\\dist\\core\\ar.mjs';
const managed='C:\\fixture\\skills\\agent-router\\core\\ar.mjs';
const match=(command, target, name, detached)=>matchesWaiter(command,target,name,detached,'win32');

test('只识别本次启动的等待者和完整任务名',()=>{
  assert.equal(match('node C:\\project\\app\\dist\\core\\ar.mjs wait 006',script,'006',true),true);
  assert.equal(match('node C:\\fixture\\skills\\agent-router\\core\\ar.mjs dispatch --name managed-exit',managed,'managed-exit',false),true);
  assert.equal(match('node C:\\user\\.claude\\skills\\agent-router\\core\\ar.mjs wait 006',script,'006',true),false);
  assert.equal(match('node C:\\project\\app\\dist\\core\\ar.mjs wait "006-M2D 画面渲染-2"',script,'006',true),false);
  assert.equal(match('node C:\\fixture\\skills\\agent-router\\core\\ar.mjs dispatch --name 006-M2D',managed,'006',false),false);
  assert.equal(match('"C:\\Program Files\\node.exe" "C:\\project\\app\\dist\\core\\ar.mjs" wait "006-M2D 画面渲染-2"',script,'006-M2D 画面渲染-2',true),true);
  assert.equal(match('node "C:\\fixture\\skills\\agent-router\\core\\ar.mjs" dispatch --name "任务 名称"',managed,'任务 名称',false),true);
  assert.equal(match('node C:/PROJECT/app/dist/core/../core/AR.MJS wait 006',script,'006',true),true);
  assert.equal(match('node C:\\project\\app\\dist\\core\\ar.mjs --name 006',script,'006',true),false);
  assert.equal(match('node C:\\fixture\\skills\\agent-router\\core\\ar.mjs wait managed-exit',managed,'managed-exit',false),false);
});

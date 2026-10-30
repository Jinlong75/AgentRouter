---
id: 000
title: 【标题】
type: code
worker: auto
allowed_paths:
  - 【允许改动的路径，例如 src/auth/**】
verify:
  - 【验收命令，例如 npm test】
expect_commit: true
verify_timeout_min: 10
# effort: high   # 可选：这个任务用的推理强度，要在执行者支持的范围内；不写就按路由规则或执行者配置
# model: 【模型名】   # 可选：这个任务用的模型；不写就按执行者配置
# review: true   # 可选：门禁通过后按审查者配置安排只读审查；reviewer: 【执行者名】 指定审查者，review_block: high 时高严重度问题打回返工
---

## 目标

【做完后是什么样子，一两句话】

## 范围 / 不做什么

【要做什么、明确不做什么】

## 参照

【相关文件、已有实现、界面稿】

## 验收标准

【逐条可检查的要求】

## 自测

【执行者自己跑的、与改动相关的测试文件和检查，例如 `node --test tests/unit/auth.test.mjs`；上面 verify 里的完整验收命令由门禁跑，执行者不用再跑一遍】

## 受影响的已有测试

【改行为前先全文搜索依赖旧行为的测试与界面检查（`tests/`、`app/src/main/shots*.ts`、`checks/`）；搜索结果不要截断，完整贴在这里；据此写上面的 allowed_paths。没有受影响的测试时写"无"，并写出搜过的关键词】

## 汇报要回答的问题

【需要执行者回答的问题】

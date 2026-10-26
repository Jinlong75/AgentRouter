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
---

## 目标

【做完后是什么样子，一两句话】

## 范围 / 不做什么

【要做什么、明确不做什么】

## 参照

【相关文件、已有实现、界面稿】

## 验收标准

【逐条可检查的要求】

## 受影响的已有测试

【改行为前先全文搜索依赖旧行为的测试与界面检查（`tests/`、`app/src/main/shots*.ts`、`checks/`）；搜索结果不要截断，完整贴在这里；据此写上面的 allowed_paths。没有受影响的测试时写"无"，并写出搜过的关键词】

## 汇报要回答的问题

【需要执行者回答的问题】

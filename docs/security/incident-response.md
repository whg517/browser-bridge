# 事件响应 Runbook

> 单维护者项目的现实版安全事件处置流程,与 [SECURITY.md](../../SECURITY.md) 的报告渠道和
> [threat-model.md](threat-model.md) 的资产/信任边界保持一致。信任边界的枚举见
> [trust-boundaries.md](trust-boundaries.md),工具风险见 [tool-risk-matrix.md](tool-risk-matrix.md)。

## 什么算安全事件

涉及 [threat-model.md](threat-model.md) 里被保护资产的失守或疑似失守,例如:

- 绕过站点白名单或确认提示,在**未授权 origin** 上执行了页面操作;
- 越过脱敏泄露 cookie / storage / 页面内容 / eval 返回值;
- 桥接 socket 接受了**未鉴权**的本地 peer,或 host manifest 的 `allowed_origins` 被改;
- `page_eval` 或其确认通道被滥用产生不可逆后果。

不属于事件:需要预先攻陷机器,或用户自己配置的恶意 MCP 客户端(按设计信任,见
[SECURITY.md 的 Scope](../../SECURITY.md#scope))。

## 报告渠道

**不要为安全问题开公开 issue。** 走 GitHub 的
**[Report a vulnerability](https://github.com/whg517/browser-bridge/security/advisories/new)**
(Security → Advisories)私密报告,包含:攻击者能做什么(影响)与跨越的信任边界、
复现步骤或 PoC、受影响的版本/commit。作为小项目,会在数日内致谢并请求合理的修复窗口。

## 分级(Triage)

收到报告后按下面几个问题定级(对齐 [tool-risk-matrix.md](tool-risk-matrix.md) 的血半径):

1. **跨越了哪个信任边界?**(见 [trust-boundaries.md](trust-boundaries.md) ①–④,④ 页面边界最关键)
2. **能读到/改到什么?** 是否触及凭证(cookie/storage token)?是否有写/不可逆后果?
3. **前置条件多强?** 是否需要用户已授权某 origin、已装扩展、本地同 UID?
4. **是否可复现?** 有无 PoC?

据此判断是"立即缓解"还是"排期修复"。凭证泄露或白名单/确认绕过属最高优先。

## 立即缓解(用户侧,无需改代码)

这些动作用户自己就能做,用于在补丁就绪前**收敛血半径**:

- **禁用单个工具**:在扩展 Options 页把出问题的工具加入 `disabledTools`
  (对应 `TOOL_DISABLED`,见 [errors.json](../../contracts/errors.json));高危工具如
  `page_eval` 应第一时间禁用。
- **收回白名单 / 关闭全站**:在 Options / popup 移除相关 origin 的授权,并确认
  `allowAllSites` 处于关闭(见 [ADR-0004](../adr/0004-allowlist-with-optional-host-permissions.md)、
  [ADR-0011](../adr/0011-options-page-for-settings.md))。移除授权会一并撤销该 origin 的
  host permission。
- **总开关(kill switch)**:在 `chrome://extensions` 停用或移除 Browser Bridge 扩展——
  扩展一停,native host 收到 stdin EOF 退出,桥接即断。必要时再退出 MCP 客户端会话,
  让 MCP server 进程结束(可用 `doctor` 确认 not reachable,见 [operations.md](../operations.md))。
- **卸载 host manifest**:删除 native messaging host manifest 后 Chrome 无法再 spawn host
  (路径见 [architecture.md §4.3](../architecture.md#43-安装产物))。

> 缓解优先级:先禁高危工具 → 收回白名单 → 停用扩展 → 卸载 manifest,由轻到重。

## 修复与验证

- 定位跨越的**不变量**(见 [trust-boundaries.md 的"不能回退的不变量"](trust-boundaries.md#invariants-that-must-not-regress))。
- 修复走**安全相关变更**门禁:补 [security-change 清单](../../.github/ISSUE_TEMPLATE/security-change.yml)、
  更新 [tool-risk-matrix.md](tool-risk-matrix.md),动了信任边界还要更新 [threat-model.md](threat-model.md)。
- **必须加负向安全测试**证明边界重新成立(不是只加正向用例),符合 [SECURITY.md 的 review bar](../../SECURITY.md#security-relevant-changes-review-bar)。

## 发布与披露

- 按 [release.md](../release.md) 打 tag 发布修复;pre-1.0 只支持最新 release
  (见 [SECURITY.md 的 Supported versions](../../SECURITY.md#supported-versions)),安全修复以新的
  patch/minor 发出。
- 通过 GitHub Security Advisory 协调披露:给报告者合理修复窗口后再公开,发布后在 advisory
  中致谢报告者并说明受影响版本与缓解措施。
- 在 [CHANGELOG.md](../../CHANGELOG.md) 记录修复。

## 相关

- 报告渠道与 review bar:[SECURITY.md](../../SECURITY.md)。
- 资产、actors、非目标:[threat-model.md](threat-model.md)。
- 边界与不变量:[trust-boundaries.md](trust-boundaries.md)。
- 运行与诊断:[operations.md](../operations.md)。

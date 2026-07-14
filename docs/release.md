# 发布:tag 驱动的发布流水线

> 本文说明 browser-bridge 如何发布:打 tag 触发预编译产物、校验和、双模式安装脚本,
> 以及解耦的 SBOM 工作流。版本纪律见 [compatibility.md](./compatibility.md);
> 安装产物路径见 [architecture.md §4.3](./architecture.md#43-安装产物)。

## 触发方式:打 tag

发布由 **git tag** 驱动(`.github/workflows/release.yml`,`on: push: tags: ["v*"]`,
另有 `workflow_dispatch` 手动入口):

```bash
git tag v0.1.0 && git push --tags
```

流水线的第一步是**版本一致性校验**:tag 去掉前导 `v` 和任何 `-dev`/`-rc` 预发布后缀后,
其核心版本必须等于 `Cargo.toml` 的 `version`,否则直接失败。Cargo 是版本单源
(见 [ADR-0013](./adr/0013-ci-and-toolchain.md))。带后缀的 tag(如 `v0.1.0-rc.1`)
会被标记为 prerelease。

## 构建矩阵与预编译 tarball

release.yml 在矩阵上构建(当前 `macos-14/arm64` 与 `ubuntu-22.04/x64`;Intel macOS 因
托管 runner 稀缺**有意省略**,Linux 用较老 glibc 基线以扩大兼容)。每个目标:

1. `cargo build --release` 出二进制。
2. `npm ci && npm run build` 出扩展 bundle(`extension/dist/`)。
3. 打包成 `browser-bridge-<tag>-<platform>-<arch>.tar.gz`,内含二进制、
   `extension/dist`、`install.sh`、`mcp-config.example.json`、`LICENSE`、`README.md`。
4. 生成 `.tar.gz.sha256` 校验和(`shasum` 或 `sha256sum`)。
5. 用 `softprops/action-gh-release` 创建 GitHub Release,附上 tarball + `.sha256`,
   并自动生成 release notes。

用户因此**不需要 Rust/Node 工具链**即可安装。所有第三方 Action 都固定到 commit SHA
(供应链治理,见 [governance-roadmap.md §4](./governance-roadmap.md))。

## 双模式 install.sh

同一份 `install.sh` 自动区分两种模式:

- **源码模式**(存在 `Cargo.toml`):现场用 Rust 构建二进制、用 Node/npm 构建扩展,再安装。
- **预编译模式**(无 `Cargo.toml`,即解压 release tarball 后):直接安装随包附带的二进制与
  `extension/dist`,**不需要** Rust 或 Node。

两种模式都注册 Chrome native messaging host manifest(`allowed_origins` 写死扩展 ID),
细节见 [architecture.md §4.3](./architecture.md#43-安装产物) 与
[operations.md](./operations.md)。Windows 用 `install.ps1`(见 [ADR-0015](./adr/0015-windows-support.md))。

## SBOM:解耦的 CycloneDX 工作流

`.github/workflows/sbom.yml` 独立于 release.yml,触发于 `release: published`(即 release
**已创建之后**):

- 用 `anchore/sbom-action` 从**提交的锁文件**(`Cargo.lock` + `extension/package-lock.json`)
  生成 CycloneDX JSON(`browser-bridge.cdx.json`),扫描声明的依赖而非已安装的树
  (fresh checkout 没有 `node_modules/target`)。
- 把 SBOM 作为资产附加到对应 tag 的 Release。

**为什么解耦**:SBOM 工作流与二进制发布分离,因此 SBOM 工具异常**永远不会阻塞**二进制发布。

## SemVer 规则

1.0 之前也守兼容纪律,不把 `0.x` 当作任意破坏兼容的借口:

- **Patch**:bug 修复、内部重构、日志改进;不改工具参数与安全语义。
- **Minor**:新增工具、新增可选字段、新增 capability、新增配置;向后兼容。
- **Major**:删除/改名工具、改字段含义、改默认权限、放宽安全边界、不兼容 Bridge protocol
  或扩展版本(对应内部桥接协议版本 bump,见 [compatibility.md](./compatibility.md))。

## 尚未落地(诚实说明)

- **provenance / attestation**:发布产物的来源证明尚未接入(路线图 P2#3)。
- macOS **真实集成测试进入 release gate**、Chrome stable/beta nightly:见
  [governance-roadmap.md §12 P2](./governance-roadmap.md#p2发布与运维治理) 的状态标注。

## 相关

- 运维与诊断:[operations.md](./operations.md)。
- 版本与握手:[compatibility.md](./compatibility.md)。
- CI 与工具链:[ADR-0013](./adr/0013-ci-and-toolchain.md)。

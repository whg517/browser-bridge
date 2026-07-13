# RFC-0002:工具注册表 / Command 模式(Rust)

- **状态**:Proposed(设计提案,尚未实现)
- **日期**:2026-07-13
- **相关**:[architecture.md §4.1](../architecture.md)、[contracts/tools.json](../../contracts/tools.json)、[contracts/capabilities.json](../../contracts/capabilities.json)

> 本文是**设计提案**,不是实现记录。目标是让 `src/tools.rs` 不再是"一个大 match",
> 而是一个可扩展的工具注册表,新增工具时改动局部化、契约一致性可编译期/测试期保证。

## Problem(问题)

`src/tools.rs` 目前把 15 个工具的 **schema 定义**与 **dispatch 分支**集中在一处:一个大的
`match name { ... }`,每个工具一条臂,分支里手写参数取值、拼 `BridgeReq`、调用
`session.call`。随工具增多,这带来:

1. **改动发散**:加一个工具要同时动 schema 列表和 match 臂,容易漏、容易与
   [tools.json](../../contracts/tools.json) 契约漂移(靠 `matches_contract` 测试兜底,但那是事后)。
2. **元数据与行为分离**:一个工具的 `name` / `permission` / `confirmation` / 输入 schema 在
   一处,真正的执行逻辑在另一处 match 臂,认知负担高。
3. **无处挂能力门**:[capabilities.json](../../contracts/capabilities.json) 引入后,
   "该工具需要哪个能力、连接是否 advertise 了它"没有自然的归属点,只能再塞进 match。
4. **难以单元测试单个工具**:逻辑耦合在巨型 match 里,无法对单个工具的 validate/execute
   做隔离测试。

## Proposed design(提案设计)

引入 **`ToolHandler` trait + 注册表(registry)**,即 Command 模式:每个工具是一个实现了
统一接口的对象,注册表按 `name` 索引它们;`tools.rs` 从"派发中枢"退化为"注册 + 查表转发"。

```rust
/// 工具的静态元数据(与 contracts/tools.json 对应,可由测试校验一致)。
pub struct ToolMeta {
    pub name: &'static str,
    pub permission: &'static str,   // Chrome 权限(tabs/scripting/debugger/cookies)
    pub capability: &'static str,   // capabilities.json 里的能力 id
    pub confirmation: &'static str, // none/warn/page-toast/high-risk/every-call
    pub description: &'static str,
    pub input_schema: &'static str, // 或结构化 schema 类型
}

pub trait ToolHandler: Send + Sync {
    /// 静态元数据。
    fn meta(&self) -> &ToolMeta;

    /// 纯参数校验:不触网、可单测。失败返回 INVALID_ARGUMENT。
    fn validate(&self, args: &serde_json::Value) -> Result<(), CallError>;

    /// 执行:把校验过的参数翻成 BridgeReq 并经 session 往返。
    fn execute(
        &self,
        session: &Session,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, CallError>;
}

/// 注册表:name -> handler。
pub struct ToolRegistry {
    tools: HashMap<&'static str, Box<dyn ToolHandler>>,
}

impl ToolRegistry {
    pub fn builtin() -> Self { /* 注册全部内置工具 */ }

    pub fn list(&self) -> Vec<&ToolMeta> { /* 供 tools/list */ }

    pub fn dispatch(
        &self,
        session: &Session,
        name: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, CallError> {
        let h = self.tools.get(name).ok_or(CallError::UnknownTool)?;
        // 能力门:连接未 advertise 该能力则前置拒绝(见 capabilities.json / RFC-0001)。
        session.ensure_capability(h.meta().capability)?;
        h.validate(args)?;
        h.execute(session, args)
    }
}
```

要点:

- **元数据与行为同居**:一个工具的 `meta()` + `validate()` + `execute()` 在同一个
  `impl` 里,新增工具 = 新增一个实现 + 在 `builtin()` 里注册一行。
- **契约一致性**:`ToolRegistry::list()` 产出的 `ToolMeta` 集合可由现有
  `matches_contract` 测试直接对着 [tools.json](../../contracts/tools.json) 断言,和今天等价甚至更强
  (逐字段而非整块)。
- **能力门自然归位**:`dispatch` 统一在 `validate/execute` 之前查
  [capabilities.json](../../contracts/capabilities.json) 的能力是否被 advertise
  (与 [RFC-0001](0001-connection-state-machine.md) 的握手能力集配合)。
- **可测**:`validate` 是纯函数,单个工具可脱离网络单测;`execute` 可用 mock `Session`。

不改变对外协议、不改变工具的运行时语义,是**内部结构重构**。

## Alternatives(考虑过的替代)

- **A:维持大 match**。零重构成本,但上述发散/耦合/难测问题不解。排除(本 RFC 的动机)。
- **B:声明宏生成分支(`macro_rules!` / 过程宏)**。能减少样板,但把逻辑藏进宏、可读性
  与可调试性下降,单测粒度仍粗。作为 A 的改良但不如 trait 直观,排除。
- **C:用 `enum` + 每工具一个 variant,`impl` 上挂方法**。比 match 稍结构化,但新增工具仍要
  改中心 enum,且无法用 `Box<dyn>` 做开放注册(未来外部注册工具受限)。可作为过渡形态。
- **D:数据驱动——从 tools.json 运行时读 schema,execute 走通用"透传 op"**。极致减少 Rust
  样板,但把类型化参数校验推迟到运行时,丢了 Rust 的编译期保障,也不利于每工具特化逻辑
  (如 `page_eval` 的确认通道)。排除。
- **E:引入外部 command 框架 crate**。与 [ADR-0001](../adr/0001-use-rust-single-binary.md)
  最小依赖原则冲突,收益不足以引入新依赖。排除。

## 落地提示(非实现)

- 先落 trait + registry 骨架,把现有 15 个 match 臂逐个搬成 handler,保持
  `matches_contract` 全绿即可视为等价迁移。
- 迁移顺序建议从最简单的只读工具(`tab_list`)开始,最后再搬带确认通道的
  `page_eval` / `page_snapshot_precise`。
- 能力门(`ensure_capability`)依赖 [RFC-0001](0001-connection-state-machine.md) 的握手先落地;
  在握手到位前,`ensure_capability` 可先恒真,保证可分阶段推进。

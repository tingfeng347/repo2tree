# 同类项目调研与实现取舍

调研日期：2026-10-15。使用 Tavily Search / Extract 检索，以项目官方仓库、规范和产品文档核对功能。下表是能力对照，不声称已试运行这些外部项目。

| 项目 | 已核实的能力 | repo2tree 借鉴 | 与本次需求的差异 |
| --- | --- | --- | --- |
| [Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail)、[交互文档](https://github.com/CoatiSoftware/Sourcetrail/blob/master/DOCUMENTATION.md) | 符号搜索、图与源码双向定位、按文件／namespace 分组、调用链 | 从一个符号进入有边界的邻域；边能回到调用位置 | 原仓库已归档；不能把静态边当成有次序的场景执行 |
| [CodeTracer](https://github.com/metacraft-labs/codetracer) | 记录执行后导航、完整已记录调用树、变量历史 | 区分函数定义和每次调用实例；回退时保持位置明确 | 主要是记录／回放；用户本轮选择不运行项目。主仓库声明 AGPLv3，本实现没有复制其代码 |
| [AppMap](https://appmap.io/docs/reference/guides/using-appmap-diagrams.html) | 从运行记录探索 HTTP → 函数 → SQL，可折叠调用路径和时序图 | 从业务入口追链，保留边界、返回及调用上下文 | 依赖运行记录，适合作为未来可选导入器，不承担本版静态执行语义 |
| [Archify](https://github.com/tt-a1i/archify)、[许可证](https://github.com/tt-a1i/archify/blob/main/LICENSE) | 基于 typed IR 生成架构、流程、时序等交互 HTML，路径与动画展示 | 数据与画布分开，当前路径突出，使用有方向的连线和移动标记 | 高层组件图不等于全函数索引；本版自己生成函数与调用点数据。MIT，未直接复制其实现 |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | Tree-sitter 提取实体和边，本地 SQLite，语义解析、未解析引用及来源 | 作为结构事实的基础索引；通过适配层读取，保留所有符号、原始边和 provenance | CodeGraph 的多语言索引支持不代表 repo2tree 已有这些语言的函数内控制流 |
| [WizTree](https://diskanalyzer.com/whats-new) | 嵌套矩形表示层级、双击缩放目录、树与图同步 | 目录 → 模块 → 类 → 函数语义缩放、返回面包屑 | 这是空间布局参考，无法提供程序的执行因果关系 |

用户写的是“wintree”。搜索未确认唯一对应软件；WizTree／WinDirStat 风格的树图符合描述，但此处只将其作为待确认的交互解释。

## 为什么采用组合架构

当前调研范围内没有发现可直接满足“静态扫描全函数、保留调用不确定性、层级树图、手动分支教学、调试式跳出”的一个现成项目。这个结论限于本轮检索，不能理解为市场上不存在相关产品。

用户已明确要求继续自研并直接重构，且选择不运行项目。因此本版复用 CodeGraph 的索引能力，自建控制流模型和播放器。对 Sourcetrail、CodeTracer、AppMap 和 Archify 借鉴的是交互原则与数据分层。

## LSP / DAP 的职责边界

[LSP 3.17 规范](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)定义 prepareCallHierarchy、incomingCalls 和 outgoingCalls。服务端可以返回符号以及调用点范围；这有助于补齐调用目标，不会给出某次输入下的分支结果。服务器是否具备调用层级能力需要协商，不能因为“支持 LSP”就视为可用。

[DAP 协议](https://microsoft.github.io/debug-adapter-protocol/overview.html)是实际调试器与界面之间的协议，stepIn / next / stepOut 的存在不意味着可以从静态图恢复真实运行。用户选择静态教学后，本版不接 DAP，也不把手动选择称为真实调试。

## 现有实现为何需要更换模型

这些判断来自本仓库源码检查，未把旧版测试通过与否当作本轮验收依据：

- `scripts/build_flow.py` 的 `container()` 会把嵌套函数上提到类／文件，丢失 lexical parent。
- `merge_leftover_edges()` 把没有被控制流提取器处理的边按行号放进顶层序列，不能证明那些边会在本次路径执行。
- `Graph.resolve()` 包含按同名唯一目标猜测的回退；新数据必须把这种关系保留为候选，并要求场景确认。
- `assets/js/03-engine.js` 的循环只展开一次，重复递归会折叠；普通调用、异常、返回和 finally 需要有可检验的控制信号。
- 原界面使用紧凑数组下标保存状态；新场景绑定明确的符号 ID、调用点 ID 和源码快照，避免索引变化后套用旧选择。

## 技术选择

Rust 负责文件、SQLite 快照、子进程协议和本机服务；Python AST 与 TypeScript Compiler API 负责第一批控制流适配；纯浏览器播放器负责可重复教学事件。此分工允许先把语义做正确，再扩展语言及大型图形渲染。

现阶段采用 SVG 展示局部图，每页限制可视节点数量，所有函数仍留在可搜索的全量数据中。大仓库的 WebGL、增量扫描与按需源码加载是后续性能工作，当前没有据此承诺大规模性能数字。

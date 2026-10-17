---
name: code-flow-debugger
description: 用 CodeGraph 扫描本地项目，生成单文件交互式 HTML“代码流调试器”：WinTree 式可逐层进入的目录/模块/类/函数树图，覆盖每个函数和调用关系；选择 HTTP API、前端组件、CLI 命令或任意函数作为入口，像调试器一样单步进入/跳过/跳出函数/跳出类/跳出模块、设断点、继续运行，并以 Archify 式流动动画展示每一步走向，分支可手动选择并统计覆盖率。用于学习、演示或讲解项目执行流程。不用于真实运行时调试或性能分析。
---

# Code Flow Debugger

把一个本地项目变成一个可以“单步调试”的静态 HTML。数据来源：

- **结构与调用边**：`<project>/.codegraph/codegraph.db`（只读）。
- **函数内控制流**：Python 用标准库 `ast`；TS/JS/TSX 用项目里的 `typescript` 包（`scripts/ts_flow.mjs`）。
- **前后端连线**：前端 `fetch/axios/request("/api/…")` 的 URL 与后端路由（FastAPI/Flask 装饰器 + `include_router` 前缀、Express `app.get`）按路径段匹配。

这是静态分析，不是真实执行：分支选择的含义是“假设这次输入走这条路”。要如实告诉用户这一点。

## 流程

1. **确认索引**。项目根没有 `.codegraph/` 时，先告诉用户需要建立索引（会在仓库里创建 `.codegraph/`），用户同意后运行 `codegraph init <project>`。已有索引但代码刚改过，就加 `--sync`。
2. **生成**：

   ```bash
   python3 <skill-dir>/scripts/build_flow.py --project <project> [--out <file.html>] [--sync] [--include-tests] [--no-source] [--typescript <typescript.js>]
   ```

   默认输出为 `<project>/.codeflow/codeflow-<时间>.html`。如果该目录没被 git 忽略，提醒用户。标准输出是 JSON 摘要（`output`、`stats`、`warnings`）。
3. **检查摘要**再交付：
   - `warnings` 里有 “未找到 node 或 typescript 包” 时，TS/JS 函数只有调用顺序，没有分支。可以用 `--typescript` 指向任意一个 `node_modules/typescript/lib/typescript.js`，或请用户在前端目录安装依赖。
   - `routes == 0`，但项目明明有 API：说明路由写法不在支持范围内（见下文“限制”），要告诉用户。
   - `http_unlinked` 偏多：说明前端 URL 是动态拼接的，或指向外部服务。
4. **交付**：给出 HTML 路径和关键数字（文件、类、函数、API、已连线的前端→后端 HTTP 调用数），附上下面的操作速查，并说明限制。用户想在浏览器里看时，用 `xdg-open`/`open` 打开。

## 操作速查（给用户）

| 操作 | 方式 |
| --- | --- |
| 选入口 | 左上列表：HTTP API / 前端组件 / 命令行 / 模块顶层 / 未被调用的函数；搜索框可搜任意函数 |
| 浏览结构 | 中间树图：单击选中，双击进入容器，面包屑返回上层，滚轮缩放，拖拽平移；左下结构树同步 |
| 单步 | ↘ 进入 (F11)、↷ 跳过 (F10)、↗ 跳出函数 (Shift+F11)、⇱ 跳出类、⇲ 跳出模块 |
| 运行 | ▶ 继续 (F8/F5)，遇到断点、未捕获异常或执行结束时停下；⏸ 暂停 (Esc) |
| 断点 | 右键树图中的函数设函数断点；点源码行号设行断点（非步骤行会吸附到下一步骤行）；“断点”页统一管理 |
| 覆盖每种输入 | 在“当前步骤”里为分支、循环、try、回调选择路径，或模拟调用抛异常；“分支覆盖”页显示该入口可达范围内的覆盖率；✚ 自动优先走未覆盖的分支 |
| 放大演示区 | 左右栏点边缘按钮折叠为细条（`[` / `]`），源码面板点 ▸ 折叠（`\`）或拖上边缘调高度，各小节标题可单独折叠；⛶ 专注（`F`）一次收起两侧和源码，再按恢复。布局记在浏览器里 |
| 看流向 | 实线为调用，橙色虚线为 HTTP，点线为返回，红线为异常；粒子沿当前边流动；镜头自动跟随（可关闭） |

断点和覆盖记录按项目路径存在浏览器 localStorage 中。

## 限制（交付时说明）

- 调用目标优先使用 CodeGraph 的边。边缺失时按“同名且唯一”推断，界面会标注“按名称推断”。动态分发、依赖注入和高阶函数可能无法连上。
- 循环只演示一次迭代或 0 次迭代。递归第二层起折叠。异常处理不区分异常类型，直接由最近的 handler 捕获。
- React 回调：`map/useEffect/useMemo/then` 等默认执行；事件处理器、`onSuccess` 一类回调默认“不触发”，可以手动改选。
- 路由识别覆盖 FastAPI/Flask/Starlette 装饰器、`include_router`/`register_blueprint` 前缀、Express 风格 `app.METHOD("/path", handler)`、typer/click 的 `@app.command()`。Django URLconf、Spring、NestJS 装饰器等暂不支持，这类项目可以从“未被调用的函数”或搜索框选入口。
- 默认排除测试文件（`--include-tests` 可包含）。单文件内嵌全部源码，大仓库可用 `--no-source` 减小体积。

## 维护

- `scripts/build_flow.py`：提取与组装；`scripts/ts_flow.mjs`：TS 控制流；`assets/viewer.html` + `viewer.css` + `assets/js/*.js`（`05-layout.js` 负责折叠布局）（按文件名顺序拼接，包在私有作用域里）：播放器。
- 流程项格式：`t` 取值为 `call|http|if|cb|loop|try|ret|raise`；`l` 是行号；`to` 是目标节点下标；`arms[].b`、`h[].b`、`b`、`el`、`f` 是嵌套块；`k` 是分支键（覆盖率统计用）。
- 测试：`python3 tests/test_build_flow.py`（需要 `codegraph`；设置 `CODEFLOW_TS=<typescript.js>` 时会同时测 TS 提取）。浏览器冒烟：先用 fixture 生成 HTML，再运行 `node tests/cdp_run.mjs <html> tests/browser_smoke.js` 和 `tests/layout_smoke.js`（需要 Chrome，可用 `CHROME` 指定路径）。

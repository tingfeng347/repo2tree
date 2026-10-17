# 演示截图

以下图片来自 repo2tree 本地应用的真实浏览器截图，没有生成、拼接或替换界面内容。

| 图片 | 界面状态 | 尺寸 |
| --- | --- | --- |
| `walkthrough-light.jpg` | 亮色，POST /api/orders → OrderService.create，第二个调用帧 | 1440 × 1000 |
| `walkthrough-dark.jpg` | 相同调用位置，中性暗色主题 | 1440 × 1000 |
| `branch-choice.jpg` | validate_quantity 的 quantity <= 0 分支，等待手动选择 | 1440 × 1000 |

数据来源：仓库 `examples/demo.project.json`，对应 `examples/shop/backend/app.py` 和 `frontend/App.tsx`。这些是静态教学数据，不代表已执行业务或已求值的变量。

复现步骤：

1. 启动应用并打开默认示例；保持两侧面板展开、源码收起。
2. 选择 `POST /api/orders`，单步两次，进入 `OrderService.create`，即可复现亮色调用截图。
3. 切换暗色，保持调用位置，即可复现暗色调用截图。
4. 从 `OrderService.create` 继续单步三次，在 `validate_quantity` 的第一个条件处暂停，即可复现分支截图。

截图时间：2026-10-15（黑白界面，仅类型小标签着色）。来源：`http://127.0.0.1:7331/`，Codex 应用内浏览器。图片携带来源元数据；这些截图保留 2026-10-15 的界面；2026-10-17 的步骤前置、入口选择与复盘布局尚未更新截图，浏览器验收被策略阻止。

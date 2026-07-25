# 截图和 GIF 演示清单

真实截图建议由项目维护者自己录制，并对公司名、HR、聊天记录、简历内容做打码处理。

建议放到：

```text
docs/assets/
```

建议补 4 张图和 1 个 GIF：

1. `popup-config.png`：插件弹窗，展示粘贴简历、匹配度阈值、排除关键词。
2. `boss-analysis-panel.png`：BOSS 搜索页右侧分析面板，展示达标岗位、低匹配岗位、统计信息。
3. `opening-message.png`：某个达标岗位的定制开场白，注意打码公司和个人信息。
4. `health-check.png`：浏览器打开 `/health`，展示后端正常启动。
5. `workflow-demo.gif`：从开始分析到点击“去沟通”，自动填入开场白，最后停在用户手动确认发送前。

README 中暂时不直接引用图片，等真实素材补齐后再加：

```md
![插件配置](docs/assets/popup-config.png)
![分析面板](docs/assets/boss-analysis-panel.png)
![自动填开场白](docs/assets/opening-message.png)
```

不要上传未打码的简历、聊天页面或 API Key。

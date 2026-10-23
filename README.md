# 歌词舞台 Lyric Stage

把 YouTube / YouTube Music 的歌曲或歌单链接贴进来播放，歌词用 [Folia](https://github.com/chthollyphile/folia-major) 的动画引擎显示。

- 歌词来自免费的 [LRCLIB](https://lrclib.net)
- 可以用 Google 账号登录（只读权限），直接播放自己的 YouTube 歌单和点过喜欢的视频
- 线上地址：https://lyric-stage-lyxuan0604-bot.vercel.app

## 来源与许可

本项目是 Folia（作者 chthollyphile，仓库 https://github.com/chthollyphile/folia-major ）的修改版本，
基于其 2026-10-23 的代码（提交 581ae3c），按 **GNU AGPL-3.0** 许可发布，完整许可见 `LICENSE`。

2026-10-23 起所做的修改：

- 新增 `src/youtube/`：YouTube 播放器、LRCLIB 歌词查找、Google 登录读歌单，以及驱动 Folia 歌词可视化的页面外壳
- 新的入口 `index.html` 和打包配置 `vite.config.ts`，只打包上面这个页面
- 删除了本项目用不到的部分：桌面版（Electron）、服务端接口、同步服务器、模组、测试等

Folia 原来的说明保留在 `README.folia.md` 和 `README.folia.en.md`。

## 本地运行

```bash
npm install --ignore-scripts
npm run dev
```

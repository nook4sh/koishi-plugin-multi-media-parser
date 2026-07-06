# koishi-plugin-multi-media-parser

Multi Media Parser：一个面向 Koishi 的通用链接 / 卡片解析插件，目前支持小红书、抖音、微博、X / Twitter、知乎。

## 功能

- 小红书：支持 `xiaohongshu.com/explore`、`xiaohongshu.com/discovery/item`、`xhslink.com`。
- 抖音：支持 `v.douyin.com`、`jx.douyin.com`、`douyin.com/video`、`douyin.com/note`、`iesdouyin.com/share`、`m.douyin.com/share`、`jingxuan.douyin.com/m`。
- 微博：支持 `weibo.com/{uid}/{id}`、`m.weibo.cn/status`、`weibo.com/tv/show`、`video.weibo.com/show`、微博文章链接。
- X / Twitter：支持 `x.com/{user}/status/{id}`、`twitter.com/{user}/status/{id}`。
- 知乎：支持问题、回答和专栏文章链接。
- 从普通文本、Koishi 卡片元素、转义 JSON 和 `data` 字段提取链接。
- 支持图片、动图、视频、原文链接、合并转发、引用回复和视频下载后发送。
- 支持通过 `parsers.<name>.enabled` 单独开关子解析器。

## 本地测试

```bash
npm install
npm test
npm run build
```

也可以直接跑一次真实解析：

```bash
npm run dev -- "http://xhslink.com/m/AixEkyLwpfs"
npm run dev -- "https://v.douyin.com/_2ljF4AmKL8/"
npm run dev -- "https://weibo.com/7207262816/P5kWdcfDe"
npm run dev -- "https://x.com/openai/status/1800000000000000000"
npm run dev -- "https://www.zhihu.com/question/67423622"
```

## Koishi 使用

```yaml
plugins:
  /absolute/path/to/koishi-plugin-multi-media-parser/lib:
    enabled: true
    parsers:
      xhs:
        enabled: true
      douyin:
        enabled: true
      weibo:
        enabled: true
      x:
        enabled: true
      zhihu:
        enabled: true
```

关闭某个子解析器：

```yaml
plugins:
  /absolute/path/to/koishi-plugin-multi-media-parser/lib:
    enabled: true
    parsers:
      xhs:
        enabled: false
      douyin:
        enabled: true
      weibo:
        enabled: true
      x:
        enabled: true
      zhihu:
        enabled: true
```

# Self-hosted IPTV Web Player

A lightweight, self-hosted web player for users who already operate an HTTP IPTV proxy. It loads two local M3U playlists, plays HTTP MPEG-TS live streams in a modern browser, and keeps channel data under your control.

一个轻量的自托管 IPTV 网页播放器，面向已经搭建 HTTP IPTV 代理的用户。播放器从本地读取两个 M3U 频道源，在现代浏览器中播放 HTTP MPEG-TS 直播流，频道数据完全由你自行管理。

[中文说明](#中文说明) · [English](#english)

> This repository contains no real channel list, subscription, relay service, or copyrighted media. Use only streams that you are authorized to access.
>
> 本仓库不提供真实频道列表、订阅、转发服务或受版权保护的媒体内容。请仅播放你有权访问的直播流。

## 中文说明

### 项目定位

本项目只负责浏览器端播放，不是 IPTV 代理服务器。你需要先把组播、UDP 或其他直播源转换成浏览器可以访问的 HTTP MPEG-TS 地址，再把地址写入 `source1.m3u` 和 `source2.m3u`。

适合以下场景：

- 已经使用 udpxy、自建网关或其他 IPTV 转发程序；
- 已经通过反向代理为直播地址配置跨域响应头；
- 希望用一个简单 HTTP 静态站点在局域网或自己的域名下播放频道。

### 功能

- 纯静态网页，无数据库、无后端接口、无需构建；
- 固定读取同目录下的 `source1.m3u` 和 `source2.m3u`；
- 支持源 1/源 2切换、搜索、频道分组与编号显示；
- 使用本地 `mpegts.js` 播放 HTTP MPEG-TS/H.264 视频；
- 使用本地 WASM 解码器补充 MPEG Layer I/II/III 音频播放；
- 自定义播放/暂停、静音、音量、画中画和全屏控制；
- 暂停时立即断开直播请求，并保留当前画面；重新播放时重新连接；
- 桌面端和移动端自适应布局。

### 目录结构

```text
selfhosted-iptv-web-player/
├─ index.html
├─ styles.css
├─ app.js
├─ audio-player.js
├─ source1.m3u
├─ source2.m3u
├─ vendor/
│  ├─ mpegts.min.js
│  └─ mpg123-decoder.min.js
├─ README.md
├─ LICENSE
└─ THIRD_PARTY_NOTICES.md
```

请保持播放器文件名不变。页面会按相对路径加载这些文件。

### 快速部署

1. 下载或克隆本仓库。
2. 编辑 `source1.m3u` 和 `source2.m3u`，删除示例频道并填入你自己的代理地址。
3. 将整个目录上传到任意 HTTP 静态文件服务，例如 Nginx、Caddy、Apache、路由器文件服务或 NAS Web 服务。
4. 在 Chrome 或 Edge 中访问 `http://你的服务器地址/目录/`。

不要直接双击 `index.html` 以 `file://` 打开；浏览器通常会阻止本地页面读取 M3U 文件。必须通过 HTTP 或 HTTPS 服务访问。

### M3U 模板

```m3u
#EXTM3U
#EXTINF:-1,001.示例频道
http://iptv-proxy.example:8080/udp/239.0.0.1:1234
```

- `#EXTINF` 逗号后的内容是显示名称；
- `001.` 形式的编号可选，播放器会在缺少编号时自动生成显示编号；
- 下一行必须是浏览器可以访问的完整 HTTP/HTTPS 直播地址；
- 示例中的 `.example` 域名是保留的无效示例地址，使用前必须替换；
- 两个模板都需要存在。如暂时只有一个源，可以把同一份列表复制到另一个文件。

频道分类根据频道名称识别“导视”“天津”“CCTV”“卫视”等关键词；其他频道归入“其他”。

### 跨域（CORS）要求

网页源和直播流只要协议、域名或端口任一不同，就属于跨域。跨域必须由直播代理或其前置反向代理返回响应头，前端 JavaScript 不能绕过浏览器的同源策略。

直播响应至少应包含：

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
```

一个通用的 Nginx 反向代理示例：

```nginx
location /iptv/ {
    proxy_pass http://127.0.0.1:4022/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
}
```

请把上游地址、监听端口和访问控制改为你的实际配置。udpxy 的主要职责是把 UDP/组播转成 HTTP；不同版本或封装方式不一定返回浏览器所需的 CORS 响应头，因此通常需要同源部署或在前面增加支持 CORS 的反向代理。

如果网页使用 HTTPS，浏览器通常会拦截 HTTP 直播流（混合内容）。此时应让直播代理也通过 HTTPS 提供服务，或让网页和直播流都使用受信任的同一 HTTP 环境。

### 浏览器和编码兼容性

- 推荐最新版 Chrome 或 Edge；
- 直播容器应为 MPEG-TS，视频建议为 H.264/AVC；
- MPEG Layer I/II/III 音频由随项目提供的 WASM 解码器处理；
- HEVC/H.265、加密流、DRM、特殊音频编码和部分厂商私有封装可能无法播放；
- 画中画能力取决于浏览器和操作系统；
- 直播源的稳定性、带宽和延迟由你的 IPTV 网络与代理决定。

### 故障排查

1. 在浏览器开发者工具的 Network/网络面板中确认 `source1.m3u`、`source2.m3u` 返回 200。
2. 确认 M3U 中的直播地址可以从当前设备访问。
3. 检查直播响应是否带有 `Access-Control-Allow-Origin`。
4. 检查 HTTPS 页面是否加载了 HTTP 直播流。
5. 如果有画面无声音，确认音轨属于 MPEG Layer I/II/III，并点击页面一次以允许浏览器启动音频。
6. 如果一直连接，检查代理是否持续输出 MPEG-TS 数据，以及视频是否为 H.264。

### 安全与隐私

- 不要把包含真实内网 IP、个人域名、访问令牌或订阅地址的 M3U 提交到公开仓库；
- 不要把未经访问控制的 IPTV 代理直接暴露到公网；
- 建议使用防火墙、来源 IP 限制、身份验证或仅局域网访问；
- 如需鉴权，请在反向代理层实现，并谨慎处理浏览器端可见的凭据；
- 本播放器不会把频道列表上传到第三方服务，但浏览器会直接请求 M3U 中配置的地址。

### 许可

本项目自有代码按 [MIT License](LICENSE) 发布。`vendor` 中的第三方组件遵循其各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

### Purpose

This project is a browser player, not an IPTV proxy server. First convert multicast, UDP, or another input into an HTTP MPEG-TS URL that a browser can reach. Then place those URLs in `source1.m3u` and `source2.m3u`.

It is intended for users who:

- already operate udpxy, a home gateway, or another IPTV relay;
- expose their streams through a reverse proxy with correct CORS headers;
- want a simple static HTTP site for playback on a LAN or a self-managed domain.

### Features

- Fully static: no database, backend API, or build step;
- Loads `source1.m3u` and `source2.m3u` from the same directory;
- Source switching, search, channel grouping, and channel numbers;
- Local `mpegts.js` bundle for HTTP MPEG-TS/H.264 video;
- Local WASM decoder for MPEG Layer I/II/III audio;
- Custom play/pause, mute, volume, picture-in-picture, and fullscreen controls;
- Pausing immediately closes the live request and freezes the current frame; resuming reconnects to the stream;
- Responsive desktop and mobile layout.

### Quick start

1. Download or clone this repository.
2. Edit `source1.m3u` and `source2.m3u`. Remove the examples and add your own proxy URLs.
3. Upload the entire directory to any static HTTP server, such as Nginx, Caddy, Apache, a router file service, or a NAS web service.
4. Open `http://your-server/path/` in Chrome or Edge.

Do not open `index.html` directly through `file://`. Browsers commonly block a local page from fetching the M3U files; serve the directory over HTTP or HTTPS.

### M3U format

```m3u
#EXTM3U
#EXTINF:-1,001.Example Channel
http://iptv-proxy.example:8080/udp/239.0.0.1:1234
```

- Text after the comma in `#EXTINF` is the displayed channel name.
- A prefix such as `001.` is optional; the player generates display numbers when no number is present.
- The following line must be a complete HTTP/HTTPS live-stream URL reachable by the browser.
- The `.example` domains in the templates are reserved placeholders and must be replaced.
- Both playlist files must exist. If you only use one source, copy the same list into the other file.

Channel groups are inferred from names containing keywords such as Guide, Tianjin, CCTV, and Satellite TV; unmatched channels go into Other. The current interface and keyword rules are optimized for Chinese channel names.

### CORS requirements

A request is cross-origin when the page and stream differ by scheme, hostname, or port. The stream server or a reverse proxy in front of it must return CORS response headers. Client-side JavaScript cannot bypass the browser same-origin policy.

At minimum, the stream response should include:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
```

Generic Nginx example:

```nginx
location /iptv/ {
    proxy_pass http://127.0.0.1:4022/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
}
```

Replace the upstream address, port, and access policy for your environment. udpxy primarily converts UDP/multicast to HTTP; depending on the build or wrapper, it may not add browser-ready CORS headers. Use same-origin deployment or place a CORS-capable reverse proxy in front of it.

Browsers normally block HTTP streams on an HTTPS page as mixed content. In that situation, expose the stream proxy over HTTPS too, or keep both the page and stream in the same trusted HTTP environment.

### Browser and codec support

- Current Chrome or Edge is recommended.
- Streams should use an MPEG-TS container with H.264/AVC video.
- MPEG Layer I/II/III audio is handled by the bundled WASM decoder.
- HEVC/H.265, encrypted streams, DRM, uncommon audio codecs, and proprietary transport variants may not play.
- Picture-in-picture availability depends on the browser and operating system.
- Stability, bandwidth, and latency depend on your IPTV network and proxy.

### Troubleshooting

1. In browser developer tools, confirm that `source1.m3u` and `source2.m3u` return HTTP 200.
2. Confirm that the playback device can reach each stream URL in the M3U files.
3. Inspect the stream response for `Access-Control-Allow-Origin`.
4. Check for an HTTPS page requesting an HTTP stream.
5. For video without audio, verify that the audio track is MPEG Layer I/II/III and click the page once to allow browser audio startup.
6. For an endless connection state, verify continuous MPEG-TS output and an H.264 video track.

### Security and privacy

- Never commit playlists containing private IP addresses, personal domains, tokens, or subscription URLs to a public repository.
- Do not expose an unrestricted IPTV proxy directly to the public Internet.
- Prefer firewall rules, source-IP restrictions, authentication, or LAN-only access.
- Implement authentication at the reverse-proxy layer and remember that browser-visible credentials are not secrets.
- The player does not upload playlists to a third-party service, but the browser directly requests every URL configured in your M3U files.

### License

Application-specific code is released under the [MIT License](LICENSE). Bundled files under `vendor` remain under their respective upstream licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

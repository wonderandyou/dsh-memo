# 重渲书架动画（MemoShelf）

产物：`../../assets/memo-shelf.webm`（VP9 + alpha，8 秒 60fps 无缝合循环，约 5.3 MB）

## 1. 改场景

源文件：`D:\AI工作站\remotion\src\shelf\MemoShelf.tsx`

关键参数（文件顶部）：

| 常量 | 含义 | 调它会发生什么 |
|---|---|---|
| `CAM_Z` | 相机到原点的距离 | 越小书架越大，越小越容易出画 |
| `RING_R` | 书架环排半径 | 越大越分散 |
| `LOOP_SECONDS` | 循环长度（8 秒） | 改长度要同步改 Composition 的 `durationInFrames` |
| `BOOKS` | 一个循环里抽几本书（4） | 与「每 90° 一本」对应 |
| `SHELVES` | 书架位置/朝向 | 环形排布，改角度即可加/减书架 |

## 2. 先看静帧（快）

```powershell
cd D:\AI工作站\remotion
$npx = 'C:\Program Files\nodejs\npx.cmd'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
& $npx remotion still MemoShelf out/shelf-check.png --frame=60 --props=out/props-dark.json --browser-executable="$edge" --bundle-cache=false
```

`--props=out/props-dark.json`（`{"backdrop":true}`）会加一层深色底，
只在本地检查时用 —— **视频本身是透明的**，不加这个参数渲出来就是透明的。

## 3. 渲视频

```powershell
& $npx remotion render MemoShelf out/memo-shelf.webm --codec=vp9 --pixel-format=yuva420p --image-format=png --crf=45 --browser-executable="$edge" --bundle-cache=false
```

- `--pixel-format=yuva420p` **必须有**，否则没有 alpha 通道
- `--crf=45` 是压缩档位；不带这个参数默认码率会到 15 MB，带上约 5.3 MB
- 480 帧在 8 核机器上约 2 分钟

## 4. 装回插件

```powershell
Copy-Item D:\AI工作站\remotion\out\memo-shelf.webm C:\Users\q3153\Documents\dsh-memo\assets\memo-shelf.webm -Force
```

然后**关掉 DSH 窗口重新打开**（client 插件不热重载）。

## 5. 验证

- 浏览器里单独播放：造一个只含 `<video src="memo-shelf.webm" autoplay muted loop>` 的 html，用 Edge 截图，
  能看到书架点线 + 抽出的书 = 解码与透明度都正常。
- 插件里：任意调一次 `memo_*` 工具，界面应浮起书架动画，约 2.6 秒后淡出、按钮重新出现。
- 视频缺失或解码失败时，会自动改用 `lib/client.js` 里的 Canvas 兜底版（同一套投影算法）。

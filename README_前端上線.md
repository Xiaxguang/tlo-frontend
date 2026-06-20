# T-LO 前端 GitHub Pages 上線說明

## 1. 修改 API 網址

打開：

`js/config.js`

把：

```js
API_BASE_URL: "https://你的-railway-後端網址.up.railway.app"
```

改成你的 Railway 後端網址。

## 2. 上傳到 GitHub

把 `tlo-frontend` 整個資料夾內容推到 GitHub repo。

## 3. 開啟 GitHub Pages

GitHub repo：

Settings → Pages → Deploy from branch → main / root

## 4. 玩家網址

玩家可使用：

```text
https://你的帳號.github.io/你的repo/?uid=玩家UID
```

如果沒有帶 `uid`，前端會提示玩家輸入玩家 UID，並存在 localStorage。

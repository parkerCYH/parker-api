# fit-track

## 目的

我會去健身房,預計會做一個 app 來維護健身紀錄。這個 service 比較特別,因為會開放給其他使用者用(像是我朋友),所以這邊的 user 系統跟 `auth` 是分開的,在 fit-track 登入用的是 fit-track 自己的 user 服務,不是 `auth`。

## 可能功能

- 獨立的 user 註冊 / 登入(不透過 `auth` service)
- 健身紀錄(重量、次數、組數等)
- 訓練歷史紀錄查詢
- 開放朋友註冊使用

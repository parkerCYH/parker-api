# Admin Dashboard 前端採 Next.js

Admin Dashboard 前端選用 Next.js(React),而非純 Vite SPA 或其他框架。理由是跟專案裡其他既有/預期的前端(README 提過 Vite、Next 等)保持一致的技術棧慣例,方便共用元件與共用 Hono OpenAPI 產生的 Zod 型別,即使 Admin Dashboard 本身是內部後台、不需要 SEO 也不特別需要 SSR。

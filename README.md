# -FHIR-

糖尿病回診互動展示：AI Agent × FHIR R4 × ICD-10-CM

1. **病人手機**：對專屬水豚管家「卡皮君」記錄血糖（寫入瀏覽器內嵌 SQLite `data/glucose.db`）、預估糖化血色素
2. **傳輸過程**：從 SQLite 擷取紀錄 → 對應 ICD-10-CM → 封裝 FHIR Bundle → 授權 → 上傳 → 驗證 → 通知原振俠醫師
3. **醫師平板**：接收病人的診斷、血糖趨勢與原始 FHIR 資料
4. **SQLite / CSV 管理**：內建互動式 SQL 查詢視窗，支援匯出／匯入 `.db` (SQLite 3) 與 `.csv` 檔案（預設假資料位於 `data/glucose.db` 與 `data/glucose_records.csv`）

## 執行

不需安裝或建置，直接用瀏覽器開啟 `index.html` 即可（Vue 3 已內附於 `vendor/`）。

> 教學展示用途，AI Agent 為規則模擬，代碼對應不作臨床使用。

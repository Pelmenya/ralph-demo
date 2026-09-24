# Проба диаграмм

Три варианта одной схемы repo-vitals: какой из них площадка нарисует.

## 1. Mermaid

```mermaid
flowchart LR
    subgraph night["① Сбор и оценка — каждую ночь в 21:00 UTC"]
        SC["SourceCraft<br/>API и файлы"] --> C["Сбор · collect<br/>новые и изменившиеся"]
        C --> B["Оценка · build<br/>шесть категорий → балл"]
    end
    B --> PG[("Postgres<br/>сырьё и снимок рейтинга")]
    subgraph serve["② Отдача — работает постоянно"]
        API["API · NestJS<br/>читает снимок при старте"] --> UI["Витрина · Next.js"]
        UI --> U["Браузер"]
    end
    PG --> API
    Y["Яндекс ID + ключ участника"] -.-> P["Свой репозиторий:<br/>тот же сбор и счёт,<br/>сырьё только в памяти"]
    P -.-> API
```

## 2. PlantUML

```plantuml
@startuml
rectangle "① Сбор и оценка — 21:00 UTC" {
  [SourceCraft API] --> [Сбор · collect]
  [Сбор · collect] --> [Оценка · build]
}
database "Postgres" as PG
[Оценка · build] --> PG
rectangle "② Отдача" {
  [API · NestJS] --> [Витрина · Next.js]
  [Витрина · Next.js] --> [Браузер]
}
PG --> [API · NestJS]
@enduml
```

## 3. Псевдографика (для сравнения)

```
 SourceCraft ──▶ collect ──▶ build ──▶ Postgres ──▶ API ──▶ Витрина ──▶ Браузер
```

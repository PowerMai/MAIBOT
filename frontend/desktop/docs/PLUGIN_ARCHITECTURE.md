# 编辑器插件架构设计

## 1. 设计理念

### 1.1 核心原则

```
通用编辑器 + 教卡驱动的领域增强
```

- **通用编辑器**：提供基础的文档编辑能力，适用于所有类型的文档
- **教卡(Teachcard)**：定义领域专业能力，驱动插件的动态加载
- **插件系统**：按需加载领域功能，保持核心简洁

### 1.2 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      用户界面 (UI Layer)                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐   │
│  │ 工具栏  │ │ 侧边栏  │ │ 状态栏  │ │ 上下文菜单      │   │
│  │ 扩展点  │ │ 扩展点  │ │ 扩展点  │ │ 扩展点          │   │
│  └────┬────┘ └────┬────┘ └────┬────┘ └───────┬─────────┘   │
│       │           │           │               │             │
│       └───────────┴───────────┴───────────────┘             │
│                           │                                  │
│                           ▼                                  │
│              ┌────────────────────────┐                      │
│              │     插件管理器          │                      │
│              │    (PluginManager)     │                      │
│              └───────────┬────────────┘                      │
│                          │                                   │
│         ┌────────────────┼────────────────┐                  │
│         │                │                │                  │
│         ▼                ▼                ▼                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐         │
│  │  核心插件   │  │  领域插件   │  │  教卡 UI 扩展   │         │
│  │  (始终激活) │  │  (按需激活) │  │  (动态配置)    │         │
│  └────────────┘  └────────────┘  └────────────────┘         │
│                          ▲                                   │
│                          │                                   │
│              ┌───────────┴───────────┐                       │
│              │    工作区配置          │                       │
│              │  - 领域标识 (domain)   │                       │
│              │  - 关联教卡 (teachcards)│                      │
│              └───────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

## 2. 插件类型

### 2.1 核心插件 (始终激活)

| 插件 | 功能 | 说明 |
|-----|------|-----|
| `core.writing` | 智能写作 | 润色、扩写、缩写、续写、纠错、翻译 |
| `core.analysis` | 文档分析 | 结构分析、质量检查、关键词提取 |
| `core.format` | 格式工具 | 表格生成、代码格式化、排版优化 |

### 2.2 领域插件 (按需激活)

| 插件 | 领域 | 功能 |
|-----|------|-----|
| `domain.tender` | 招投标 | 要求检查、风险分析、响应生成 |
| `domain.legal` | 法律 | 条款审核、合规检查、风险标注 |
| `domain.report` | 报告 | 数据可视化、图表生成、摘要 |
| `domain.code` | 代码 | 语法高亮、代码解释、Bug 检测 |

## 3. 扩展点定义

### 3.1 工具栏扩展 (ToolbarAction)

```typescript
interface ToolbarAction {
  id: string;
  label: string;
  icon: string;
  tooltip?: string;
  shortcut?: string;
  variant?: 'default' | 'primary' | 'secondary';
  position?: 'left' | 'right';
  requiresSelection?: boolean;
  handler: (context: PluginContext) => Promise<void>;
}
```

### 3.2 菜单扩展 (MenuExtension)

```typescript
interface MenuExtension {
  id: string;
  label: string;
  icon: string;
  color?: string;
  position?: 'left' | 'right';
  items: MenuItem[];
}
```

### 3.3 侧边栏面板 (SidebarPanel)

```typescript
interface SidebarPanel {
  id: string;
  title: string;
  icon: string;
  position: 'left' | 'right';
  priority?: number;
  component: React.ComponentType<{ context: PluginContext }>;
}
```

### 3.4 上下文菜单 (ContextMenuItem)

```typescript
interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  when?: 'always' | 'selection' | 'line';
  handler: (context: PluginContext, selection?: string) => Promise<void>;
}
```

## 4. 教卡驱动机制

### 4.1 教卡 UI 扩展配置

教卡可以定义自己的 UI 扩展，在加载到工作区时自动生效：

```typescript
// 教卡 manifest.json
{
  "id": "tender-master",
  "name": "招投标大师",
  "domain": "tender",
  "uiExtensions": {
    "toolbarActions": [
      {
        "id": "quick-check",
        "label": "快速检查",
        "icon": "FileSearch",
        "handler": "skills/quick-check"
      }
    ],
    "menuExtensions": [
      {
        "id": "tender-menu",
        "label": "招投标",
        "items": [...]
      }
    ]
  }
}
```

### 4.2 插件激活逻辑

```typescript
// 插件激活条件
shouldActivate: (workspace) => {
  // 1. 检查工作区领域
  if (workspace.domain === 'tender') return true;
  
  // 2. 检查关联教卡
  return workspace.teachcards.some(tc => 
    tc.domain === 'tender' || 
    tc.id.includes('tender')
  );
}
```

## 5. 使用示例

### 5.1 注册内置插件

```typescript
// App.tsx 或入口文件
import { registerBuiltinPlugins } from '@/lib/plugins';

// 应用启动时注册
registerBuiltinPlugins();
```

### 5.2 切换工作区

```typescript
import { pluginManager } from '@/lib/plugins';

// 用户切换到招投标工作区
const handleWorkspaceChange = async (workspace: Workspace) => {
  // 获取工作区关联的教卡
  const teachcards = await teachcardsAPI.getByWorkspace(workspace.id);
  
  // 更新插件管理器
  await pluginManager.updateWorkspace(
    workspace.domain,  // 'tender'
    teachcards
  );
};
```

### 5.3 渲染插件扩展

```tsx
// EditorToolbar.tsx
import { pluginManager } from '@/lib/plugins';

function EditorToolbar() {
  const menus = pluginManager.getMenuExtensions();
  const actions = pluginManager.getToolbarActions();
  
  return (
    <div className="toolbar">
      {/* 核心操作 */}
      <Button>编辑</Button>
      <Button>预览</Button>
      
      {/* 插件菜单 */}
      {menus.map(menu => (
        <DropdownMenu key={menu.id}>
          <DropdownMenuTrigger>
            <Icon name={menu.icon} />
            {menu.label}
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {menu.items.map(item => (
              <DropdownMenuItem 
                key={item.id}
                onClick={() => item.handler?.(context)}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      
      {/* 插件快捷按钮 */}
      {actions.map(action => (
        <Button 
          key={action.id}
          onClick={() => action.handler(context)}
        >
          <Icon name={action.icon} />
          {action.label}
        </Button>
      ))}
    </div>
  );
}
```

## 6. 自定义插件开发

### 6.1 创建新插件

```typescript
// plugins/my-plugin.ts
import type { EditorPlugin } from '@/lib/plugins';

export const myPlugin: EditorPlugin = {
  meta: {
    id: 'custom.my-plugin',
    name: '我的插件',
    version: '1.0.0',
    category: 'utility',
    domains: ['all'], // 适用于所有领域
  },
  
  menuExtensions: [
    {
      id: 'my-menu',
      label: '我的功能',
      icon: 'Star',
      items: [
        {
          id: 'action1',
          label: '操作1',
          handler: async (ctx) => {
            // 实现逻辑
          },
        },
      ],
    },
  ],
};
```

### 6.2 注册插件

```typescript
import { pluginManager } from '@/lib/plugins';
import { myPlugin } from './plugins/my-plugin';

pluginManager.register(myPlugin);
```

## 7. 最佳实践

1. **核心保持简洁**：通用编辑器只包含最基础的功能
2. **领域功能插件化**：所有领域特定功能通过插件实现
3. **教卡驱动**：领域能力由教卡定义，UI 扩展随教卡加载
4. **按需加载**：只激活当前工作区需要的插件
5. **统一接口**：所有插件使用相同的 PluginContext 接口


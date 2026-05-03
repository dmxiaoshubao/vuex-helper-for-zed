# Vuex Helper for Zed（中文说明）

Vuex Helper for Zed 为 Zed 提供 Vuex 2 的跳转、补全、悬浮提示和诊断能力。

只要是 Vuex 开发里常用的辅助能力，这里都会尽量配齐：从发现、补全、跳转、查看到校验，让 Vuex State、Getters、Mutations 和 Actions 的使用更清晰。

## 功能特性

### 1. 跳转定义

从组件中直接跳转到 Vuex Store 的定义处。

#### 演示：跳转定义

#### ![Jump to Definition](images/jump_definition.gif)

- **支持**: `this.$store.state/getters/commit/dispatch`，以及直接导入的 store 实例（如 `import store from '@/store'`）
- **Map 辅助函数**: `mapState`, `mapGetters`, `mapMutations`, `mapActions`
- **命名空间**: 支持 namespaced 模块及其嵌套。
- **可选链**: 支持 `?.` 形式的 store 访问链。

### 2. 智能代码补全

智能提示 Vuex 的各种 key 以及组件中映射的方法。

#### 演示：智能补全

#### ![Code Completion (Variables)](images/auto_tips_and_complete_for_var.gif)

#### ![Code Completion (Functions)](images/auto_tips_and_complete_for_func.gif)

- **上下文感知**: 在 `dispatch` 中提示 Actions，在 `commit` 中提示 Mutations。
- **命名空间过滤**: 当使用 `mapState('user', [...])` 时，会自动过滤并仅显示 `user` 模块下的内容。
- **组件映射方法**: 输入 `this.` 即可提示映射的方法（例如 `this.increment` 映射自 `...mapMutations(['increment'])`）。
- **方括号语法**: 支持 `this['namespace/method']` 语法访问映射属性。
- **语法支持**: 支持数组语法和对象别名语法（例如 `...mapActions({ alias: 'name' })`）。
- **导入 Store 补全**: 支持 `import store from '@/store'` 后的 `store.state/getters/commit/dispatch` 补全。

### 3. 悬浮提示与类型推导

无需跳转即可查看文档、类型详情。

#### 演示：悬浮文档

#### ![Hover Info](images/hover_info_and_type_inference.gif)

- **JSDoc 支持**: 提取并显示 Store 定义处的 `/** ... */` 注释文档。
- **State 类型**: 在悬浮提示中自动推导并显示 State 属性的类型（例如 `(State) appName: string`）。
- **详细信息**: 显示类型及定义所在的文件路径。
- **映射方法**: 支持查看映射方法的 Store 文档。
- **导入 Store 悬浮**: 支持直接导入 store 实例后的悬浮提示。

### 4. Store 内部调用

同样支持在 Vuex Store 内部进行代码补全、跳转和悬浮提示。

#### 演示：Store 内部代码补全、跳转、悬浮提示

#### ![Internal Usage](images/internal_usage.gif)

- **模块作用域**: 当在模块文件中编写 Action 时，`commit` 和 `dispatch` 的代码补全会自动过滤并仅显示当前模块的内容。
- **Action Context 对象写法**: 支持在 store 文件里识别 `context.state`、`context.getters`、`context.rootState`、`context.rootGetters`。
- **对象式 Action Handler**: 支持 `actions: { someAction: { handler(ctx) {}, root: true } }` 这类 Vuex 对象式 action 写法。

### 5. 诊断

在 Zed 中直接以 Warning 标记不存在的 Vuex Store 引用。

- **辅助函数**: 校验 `mapState`、`mapGetters`、`mapMutations`、`mapActions` 中的字符串参数。
- **Commit / Dispatch**: 检查 `commit()` 和 `dispatch()` 的第一个字符串参数。
- **Store 访问**: 校验 `$store.state/getters` 第一层点号访问和方括号访问。
- **Store 内部引用**: 校验 store 文件中的 `state.xxx` 访问，以及 `rootState` / `rootGetters` 引用。
- **全局 Getter 冲突**: 当根模块或非命名空间模块注册了重复的全局 getter 名时给出 Warning。
- **注释行规避**: 对整行注释中的常见引用不报 Warning。

## 支持的语法示例

- **辅助函数**:
  ```javascript
  ...mapState(['count'])
  ...mapState('user', ['name']) // 命名空间支持
  ...mapState({ alias: 'count' }) // 对象别名支持
  ...mapState({ count: state => state.count }) // 箭头函数
  ...mapState({ count(state) { return state.count } }) // 普通函数
  ...mapActions({ add: 'increment' }) // 对象别名支持
  ...mapActions(['add/increment'])
  ```

- **Store 方法**:
  ```javascript
  this.$store.commit('SET_NAME', value);
  this.$store.dispatch('user/updateName', value);
  import store from '@/store';
  store.commit('SET_NAME', value);
  store?.getters?.['others/hasNotifications'];
  commit('increment', null, { root: true });
  actions: {
    publishProfile: {
      handler(context) {
        return context.state.ready;
      },
      root: true
    }
  }
  ```

- **组件方法**:
  ```javascript
  this.increment(); // 映射自 mapMutations
  this.appName; // 映射自 mapState
  ```

## 功能覆盖

| 功能                                        | 状态 | 说明                                               |
| ------------------------------------------- | ---- | -------------------------------------------------- |
| `mapState` — 数组语法                       | 支持 | `...mapState(['count'])`                           |
| `mapState` — 对象字符串别名                 | 支持 | `...mapState({ alias: 'count' })`                  |
| `mapState` — 箭头函数                       | 支持 | `...mapState({ c: state => state.count })`         |
| `mapState` — 普通函数                       | 支持 | `...mapState({ c(state) { return state.count } })` |
| `mapState` — 命名空间                       | 支持 | `...mapState('user', [...])`                       |
| `mapGetters` — 数组 / 对象                  | 支持 |                                                    |
| `mapMutations` — 数组 / 对象                | 支持 |                                                    |
| `mapActions` — 数组 / 对象                  | 支持 |                                                    |
| `this.$store.state/getters/commit/dispatch` | 支持 | 点号和方括号语法                                   |
| 导入 store 实例访问                         | 支持 | `import store from '@/store'`                      |
| Store 可选链访问                            | 支持 | `this.$store?.getters?.['a/b']`                    |
| `createNamespacedHelpers`                   | 支持 |                                                    |
| 对象风格 commit                             | 支持 | `commit({ type: 'inc' })`                          |
| `state` 函数形式                            | 支持 | `state: () => ({})`                                |
| 嵌套 state                                  | 支持 | 递归解析                                           |
| 计算属性名                                  | 支持 | ``[SOME_MUTATION]`` ``(state) {}``                 |
| 动态模块 import/require                     | 支持 | ES Module 和 CommonJS                              |
| 命名空间模块                                | 支持 | 含嵌套模块                                         |
| `this` 别名补全                             | 支持 | `const _t = this; _t.`                             |
| `{ root: true }` 命名空间切换               | 支持 | commit/dispatch 的 root 选项                       |
| State 链式路径中间词跳转                    | 支持 | 点击 `state.user.name` 中的 `user`                 |
| Vuex 依赖检测                               | 支持 | 工作区无 Vuex 依赖时静默不激活                     |
| `rootState` / `rootGetters`                 | 支持 | 补全、跳转、悬浮和诊断                             |
| `context.state` / `context.getters`         | 支持 | store 文件中的补全、跳转、悬浮与诊断               |
| 对象式 action handler                       | 支持 | `actions: { save: { handler(ctx) {}, root: true } }` |
| 嵌套模块命名空间继承                        | 支持 | 子模块在适用时继承父命名空间下的资产               |
| 全局 getter 冲突诊断                        | 支持 | root 与非 namespaced 模块的重名 getter Warning     |
| 无效 Store 引用诊断                         | 支持 | 不存在的 state/getter/mutation/action 以 Warning 标记 |

## 使用要求

- Zed 编辑器。
- 使用 Vuex 2 的 Vue 2 项目。
- 项目入口建议位于 `src/main.{js,ts}`、`src/index.{js,ts}`，并通过 `new Vue({ store })` 注入 Vuex store。

## 当前范围

当前 Zed 版本聚焦以下能力：

- 跳转定义
- 代码补全
- 悬浮提示
- 诊断

## 暂不包含

- Rename
- References
- Workspace Symbol
- Code Action
- Zed 专属配置 UI

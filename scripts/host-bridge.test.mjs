import assert from 'node:assert/strict';
import { createHostBridge } from '../src/host-bridge.js';

function makeContext() {
    return {
        groupId: null,
        characterId: 0,
        characters: [{ avatar: 'mirror.png', name: '镜像角色' }],
        chatId: '联机存档-abcd1234',
        chat: [],
        addOneMessage: () => {},
        updateMessageBlock: () => {},
        clearChat: () => {},
        printMessages: () => {},
        saveChat: async () => {},
        eventSource: {},
        eventTypes: {},
        generate: async () => {},
        getRequestHeaders: () => ({}),
    };
}

// 远端编辑要与酒馆原生编辑一致：mes 与当前 swipe 槽位同时更新，
// 否则本地 swipe 一次再滑回来，文本会回退成编辑前的旧版。
{
    const context = makeContext();
    const bridge = createHostBridge(() => context);
    bridge.bindCurrentChat();
    context.chat.push({
        name: '角色', is_user: false, is_system: false,
        mes: '旧文本', swipe_id: 1, swipes: ['备选0', '旧文本'],
        extra: { stmpMessageId: 'm1' },
    });
    assert.equal(bridge.applyRemoteUpdate({ messageId: 'm1', text: '新文本' }), true);
    assert.equal(context.chat[0].mes, '新文本');
    assert.deepEqual(context.chat[0].swipes, ['备选0', '新文本']);
    console.log('PASS 远端编辑同步更新当前 swipe 槽位');
}

{
    const context = makeContext();
    const bridge = createHostBridge(() => context);
    bridge.bindCurrentChat();
    context.chat.push({
        name: '玩家', is_user: true, is_system: false,
        mes: '旧发言', extra: { stmpMessageId: 'm2' },
    });
    assert.equal(bridge.applyRemoteUpdate({ messageId: 'm2', text: '新发言' }), true);
    assert.equal(context.chat[0].mes, '新发言');
    assert.equal(Object.hasOwn(context.chat[0], 'swipes'), false);
    console.log('PASS 无 swipe 的消息编辑不引入 swipes 字段');
}

// 生成期间切走聊天会把占位气泡落盘成残影；重绑时清残影、留活动气泡。
{
    const context = makeContext();
    const bridge = createHostBridge(() => context);
    bridge.bindCurrentChat();
    context.chat.push(
        { name: 'A', is_user: true, is_system: false, mes: '正文', extra: { stmpMessageId: 'm1' } },
        { name: '角色', is_user: false, is_system: false, mes: '……', extra: { stmpStreamBubble: 'bubble-stale' } },
    );
    assert.equal(bridge.beginStreamBubble('角色'), true);
    assert.equal(context.chat.length, 3);
    assert.equal(bridge.pruneStaleStreamBubbles(), 1);
    assert.equal(context.chat.length, 2);
    assert.equal(context.chat[0].extra.stmpMessageId, 'm1');
    assert.equal(bridge.hasStreamBubble(), true);
    console.log('PASS 残留流式气泡被清理，活动气泡保留');
}

// 生成结束时气泡不在当前聊天（切走了）：endStreamBubble 仍要复位活动 ID，
// 否则残影会被当成活动气泡而躲过重绑时的清理。
{
    const context = makeContext();
    const bridge = createHostBridge(() => context);
    bridge.bindCurrentChat();
    assert.equal(bridge.beginStreamBubble('角色'), true);
    context.chat = []; // 切走聊天：当前数组不再包含气泡
    assert.equal(bridge.endStreamBubble(null), false);
    // 切回镜像聊天：磁盘加载出带残影的历史
    context.chat = [
        { name: '角色', is_user: false, is_system: false, mes: '……', extra: { stmpStreamBubble: 'bubble-ghost' } },
    ];
    assert.equal(bridge.pruneStaleStreamBubbles(), 1);
    assert.equal(context.chat.length, 0);
    console.log('PASS 气泡不在场时生成结束也复位活动 ID，重绑后残影可清');
}

// 远端成员的发言必须带 force_avatar：UI 才不会用看者本人的头像渲染，
// 且酒馆默认名字行为（CC 的 DEFAULT / Instruct 的 FORCE）靠它给 prompt
// 加“名字: ”前缀——否则 AI 分不清多名成员的发言。AI 回复不需要。
{
    const context = makeContext();
    const bridge = createHostBridge(() => context);
    bridge.bindCurrentChat();
    bridge.writeStoryMessage({ messageId: 'u1', authorName: '小明', text: '你好', role: 'user' });
    bridge.writeStoryMessage({ messageId: 'a1', authorName: '角色', text: '回复', role: 'assistant' });
    assert.equal(context.chat[0].force_avatar, 'img/user-default.png');
    assert.equal(context.chat[0].name, '小明');
    assert.equal(Object.hasOwn(context.chat[1], 'force_avatar'), false);
    console.log('PASS 成员发言带默认强制头像，AI 回复不带');
}

// 旧版本写入的历史成员消息没有 force_avatar：catchUp 补打（只认插件
// 代写的 stmpAuthor 消息，自己经输入框发的原生消息不能被误改）。
{
    const context = makeContext();
    const bridge = createHostBridge(() => context);
    bridge.bindCurrentChat();
    context.chat.push(
        { name: '小红', is_user: true, is_system: false, mes: '旧消息', extra: { stmpMessageId: 'u1', stmpAuthor: '小红' } },
        { name: '我', is_user: true, is_system: false, mes: '自己的消息', extra: { stmpMessageId: 'u2' } },
    );
    bridge.catchUp([
        { messageId: 'u1', authorName: '小红', text: '旧消息', role: 'user' },
        { messageId: 'u2', authorName: '我', text: '自己的消息', role: 'user' },
    ]);
    assert.equal(context.chat[0].force_avatar, 'img/user-default.png');
    assert.equal(Object.hasOwn(context.chat[1], 'force_avatar'), false);
    console.log('PASS catchUp 给历史成员消息补打强制头像，自己的消息不受影响');
}

// 活动流式气泡在场时，后到的成员发言必须插到气泡前面（AI 回复的权威
// 顺序在本回合全部发言之后），而不是排到气泡下面。
{
    const context = makeContext();
    const bridge = createHostBridge(() => context);
    bridge.bindCurrentChat();
    assert.equal(bridge.beginStreamBubble('角色'), true);
    bridge.writeStoryMessage({ messageId: 'u1', authorName: '房主', text: '迟到的发言', role: 'user' });
    assert.equal(context.chat.length, 2);
    assert.equal(context.chat[0].extra.stmpMessageId, 'u1');
    assert.equal(Object.hasOwn(context.chat[1].extra, 'stmpStreamBubble'), true);
    // 气泡仍是活动气泡，定稿在末尾原地完成
    assert.equal(bridge.endStreamBubble({ text: '正式回复', messageId: 'a1', name: '角色' }), true);
    assert.equal(context.chat[1].mes, '正式回复');
    assert.equal(context.chat[1].extra.stmpMessageId, 'a1');
    console.log('PASS 活动气泡在场时成员发言插到气泡前，定稿顺序正确');
}

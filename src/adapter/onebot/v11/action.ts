/* eslint-disable camelcase */
import { getVersion } from '@tauri-apps/api/app'

import { AdapterActionHandler } from '~/adapter/action'
import { Behav } from '~/adapter/behav'
import { UnsupportedActionError, InternalHandlerError, ProtocolError } from '~/adapter/errors'

import { MessageHandler, createMessage } from './message'
import { response } from './utils'

import type {
  GroupSender,
  PrivateSender,
  PrivateMessageEvent,
  GroupMessageEvent,
  FriendRequestEvent,
  GroupRequestEvent,
} from './event'
import type { Messages } from './message'
import type { ActionResponse, ActionRequest, ActionStrategy } from '~/adapter/action'
import type { StrKeyObject } from '~/adapter/typed'

const messageHandler = new MessageHandler()

export class ActionHandler extends AdapterActionHandler {
  readonly strategy = actionStrategy

  async handle({ action, params }: ActionRequest): Promise<ActionResponse> {
    try {
      action = action.replace(/_async$/, '')
      const func = this.strategy[action]
      if (!func) {
        throw new UnsupportedActionError(response(1404, { message: '不支持的动作请求' }))
      }
      const asyncFn = asyncWrapper<ActionResponse>(func)
      return await asyncFn(params)
    } catch (error) {
      const errStr = String(error)
      void logger.error(errStr)
      throw error instanceof ProtocolError ? error : new InternalHandlerError(response(1000, { message: errStr }))
    }
  }
}

const actionStrategy: ActionStrategy = {
  /** 发送私聊消息 */
  'send_private_msg': async ({
    user_id,
    message,
  }: {
    user_id: number
    message: Messages[] | string
    auto_escape: boolean
  }): Promise<ActionResponse<MessageData> | ActionResponse<ErrorInfo>> => {
    return await (actionStrategy.send_msg as (request: StrKeyObject) => Promise<ActionResponse<MessageData>>)({
      message_type: 'private',
      user_id,
      message,
    })
  },

  /** 发送群聊消息 */
  'send_group_msg': async ({
    group_id,
    message,
  }: {
    group_id: number
    message: Messages[] | string
    auto_escape: boolean
  }): Promise<ActionResponse<MessageData> | ActionResponse<ErrorInfo>> => {
    return await (actionStrategy.send_msg as (request: StrKeyObject) => Promise<ActionResponse<MessageData>>)({
      message_type: 'group',
      group_id,
      message,
    })
  },

  /** 发送消息 */
  'send_msg': async ({
    message_type,
    user_id,
    group_id,
    message,
  }: {
    message_type?: 'private' | 'group'
    user_id?: number
    group_id?: number
    message: Messages[] | string
    auto_escape: boolean
  }): Promise<ActionResponse<MessageData> | ActionResponse<ErrorInfo>> => {
    const behav = new Behav()
    const pokeMs = Array.isArray(message) ? (message.find(ms => ms.type === 'poke')!) : undefined
    if (pokeMs) {
      const behav = new Behav()
      await behav.pokeUser(behav.state.bot!.id, pokeMs.data.id, group_id ? group_id.toString() : undefined)
      return response(0, { message_id: 0 })
    }
    let receiver
    if (message_type === 'private' || (!message_type && user_id)) {
      receiver = await getContact('user', user_id?.toString() || '')
    } else if (message_type === 'group' || (!message_type && group_id)) {
      receiver = await getContact('group', group_id?.toString() || '')
    }
    if (!receiver) {
      return response(1000, { message: '发送的目标不存在' })
    }
    const messages = typeof message === 'string' ? [createMessage('text', { text: message })] : message
    const contents = await messageHandler.parse(messages)
    const scene = await behav.sendMessage(behav.state.bot!, receiver, contents)
    scene.original_message = messages
    return response(0, { message_id: Number(scene.message_id) })
  },

  /** 撤回消息 */
  'delete_msg': async ({ message_id }: { message_id: number }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.recallMessage(message_id.toString(), behav.state.bot!.id)
    return response(0)
  },

  /** 获取消息 */
  'get_msg': ({
    message_id,
  }: {
    message_id: number
  }): ActionResponse<MessageInfo> | ActionResponse<ErrorInfo> => {
    const chat = useChatStore()
    const messageChat = chat.getMessage(message_id.toString())
    if (!messageChat) {
      return response(1404, { message: '消息不存在' })
    }
    const { time, message_type, sender, message } = messageChat.event as PrivateMessageEvent | GroupMessageEvent
    return response(0, {
      time,
      message_type,
      message_id,
      real_id: message_id,
      sender,
      message,
    })
  },

  /** 群组踢人 */
  'set_group_kick': async ({
    group_id,
    user_id,
  }: {
    group_id: number
    user_id: number
    reject_add_request: boolean
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.removeGroupMember(group_id.toString(), user_id.toString(), behav.state.bot!.id)
    return response(0)
  },

  /** 群组单人禁言 */
  'set_group_ban': async ({
    group_id,
    user_id,
    duration = 30 * 60,
  }: {
    group_id: number
    user_id: number
    duration: number
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.banGroupMember(group_id.toString(), user_id.toString(), behav.state.bot!.id, duration)
    return response(0)
  },

  /** 群组全员禁言 */
  'set_group_whole_ban': async ({
    group_id,
    enable = true,
  }: {
    group_id: number
    enable: boolean
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.banGroupWhole(group_id.toString(), behav.state.bot!.id, enable)
    return response(0)
  },

  /** 设置群组管理员 */
  'set_group_admin': async ({
    group_id,
    user_id,
    enable = true,
  }: {
    group_id: number
    user_id: number
    enable: boolean
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.setGroupAdmin(group_id.toString(), user_id.toString(), behav.state.bot!.id, enable)
    return response(0)
  },

  /** 设置群名片 */
  'set_group_card': async ({
    group_id,
    user_id,
    card = '',
  }: {
    group_id: number
    user_id: number
    card: string
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.editGroupMemberCard(group_id.toString(), user_id.toString(), behav.state.bot!.id, card)
    return response(0)
  },

  /** 设置群名 */
  'set_group_name': async ({
    group_id,
    group_name,
  }: {
    group_id: number
    group_name: string
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.editGroupName(group_id.toString(), behav.state.bot!.id, group_name)
    return response(0)
  },

  /** 退出群组 */
  'set_group_leave': async ({
    group_id,
    is_dismiss = false,
  }: {
    group_id: number
    is_dismiss: boolean
  }): Promise<ActionResponse<null> | ActionResponse<ErrorInfo>> => {
    const behav = new Behav()
    if (is_dismiss) {
      await behav.dismissGroup(group_id.toString(), behav.state.bot!.id)
      return response(0)
    } else {
      await behav.removeGroupMember(group_id.toString(), behav.state.bot!.id, behav.state.bot!.id)
      return response(0)
    }
  },

  /** 设置群组专属头衔 */
  'set_group_special_title': async ({
    group_id,
    user_id,
    special_title = '',
    duration = -1,
  }: {
    group_id: number
    user_id: number
    special_title: string
    duration: number
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.editGroupMemberspecialTitle(
      group_id.toString(),
      user_id.toString(),
      behav.state.bot!.id,
      special_title,
      duration,
    )
    return response(0)
  },

  /** 处理加好友请求 */
  'set_friend_add_request': async ({
    flag,
    approve = true,
    remark = '',
  }: {
    flag: string
    approve: boolean
    remark: string
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.approveAddFriend(flag, behav.state.bot!.id, approve, remark)
    return response(0)
  },

  /** 处理加群请求／邀请 */
  'set_group_add_request': async ({
    flag,
    approve = true,
    reason = '',
  }: {
    flag: string
    approve: boolean
    reason: string
  }): Promise<ActionResponse<null>> => {
    const behav = new Behav()
    await behav.approveJoinGroup(flag, behav.state.bot!.id, approve, reason)
    return response(0)
  },

  /** 获取登录号信息 */
  'get_login_info': (): ActionResponse<{ user_id: number, nickname: string }> => {
    const state = useStateStore()
    return response(0, { user_id: Number(state.bot!.id), nickname: state.bot!.name })
  },

  /** 获取陌生人信息 */
  'get_stranger_info': async ({
    user_id,
  }: {
    user_id: number
  }): Promise<ActionResponse<StrangerInfo> | ActionResponse<ErrorInfo>> => {
    const user = await db.users.get(user_id.toString())
    if (!user) {
      return response(1404, { message: '用户不存在' })
    }
    return response(0, {
      user_id,
      nickname: user.name,
      sex: user.sex || 'unknown',
      age: user.birthdate ? getUserAge(user.birthdate) : 0,
      reg_time: user.regTime,
    })
  },

  /** 获取好友列表 */
  'get_friend_list': async (): Promise<ActionResponse<{ user_id: number, nickname: string, remark: string }[]>> => {
    const state = useStateStore()
    const friends = await db.friends.where({ userId: state.bot!.id }).toArray()
    const friendList = friends.map(async (friend) => {
      const user = await db.users.get(friend.friendId)
      return {
        user_id: Number(friend.friendId),
        nickname: user?.name || '',
        remark: friend.remark,
      }
    })
    return response(0, await Promise.all(friendList))
  },

  /** 获取群信息 */
  'get_group_info': async ({
    group_id,
  }: {
    group_id: number
  }): Promise<ActionResponse<GroupInfo> | ActionResponse<ErrorInfo>> => {
    const group = await db.groups.get(group_id.toString())
    if (!group) {
      return response(1404, { message: '群组不存在' })
    }
    return response(0, getGroupInfo(group))
  },

  /** 获取群列表 */
  'get_group_list': async (): Promise<ActionResponse<GroupInfo[]>> => {
    const state = useStateStore()
    const members = await db.members.where({ userId: state.bot!.id }).toArray()
    const groupList = members.map(async (member) => {
      const group = await db.groups.get(member.groupId)
      return getGroupInfo(group!)
    })
    return response(0, await Promise.all(groupList))
  },

  /** 获取群成员信息 */
  'get_group_member_info': async ({
    group_id,
    user_id,
  }: {
    group_id: number
    user_id: number
  }): Promise<ActionResponse<MemberInfo> | ActionResponse<ErrorInfo>> => {
    const state = useStateStore()
    const groupId = group_id.toString()
    const operator = await db.members.get({ groupId, userId: state.bot!.id })
    if (!operator) {
      return response(1403, { message: '没有加入该群' })
    }
    const member = await db.members.get({ groupId, userId: user_id.toString() })
    if (!member) {
      return response(1404, { message: '群成员不存在' })
    }
    const info = await getMemberInfo(member, operator.role)
    return response(0, info)
  },

  /** 获取群成员列表 */
  'get_group_member_list': async ({
    group_id,
  }: {
    group_id: number
  }): Promise<ActionResponse<MemberInfo[]> | ActionResponse<ErrorInfo>> => {
    const state = useStateStore()
    const operator = await db.members.get({ groupId: group_id.toString(), userId: state.bot!.id })
    if (!operator) {
      return response(1403, { message: '没有加入该群' })
    }
    const members = await db.members.where({ groupId: group_id }).toArray()
    const infoList = members.map(async member => await getMemberInfo(member, operator.role))
    return response(0, await Promise.all(infoList))
  },

  /** 检查是否可以发送图片 */
  'can_send_image': (): ActionResponse<{ yes: boolean }> => {
    return response(0, {
      yes: true,
    })
  },

  /** 检查是否可以发送图片 */
  'can_send_record': (): ActionResponse<{ yes: boolean }> => {
    return response(0, {
      yes: true,
    })
  },

  /** 获取运行状态 */
  'get_status': (): ActionResponse<{ online: boolean, good: boolean }> => {
    return response(0, {
      online: true,
      good: true,
    })
  },

  /** 获取版本信息 */
  'get_version_info': async (): Promise<
    ActionResponse<{ app_name: string, app_version: string, protocol_version: string }>
  > => {
    const appVersion = await getVersion()
    return response(0, {
      app_name: 'matcha',
      app_version: appVersion,
      protocol_version: 'v11',
    })
  },

  /** 对事件执行快速操作 */
  '.handle_quick_operation': async ({
    context,
    operation,
  }:
    | PrivateMessageQuickOperation
    | GroupMessageQuickOperation
    | FriendRequestQuickOperation
    | GroupRequestQuickOperation): Promise<ActionResponse> => {
    if (context.post_type === 'message') {
      if ('reply' in operation && operation.reply) {
        let message = operation.reply
        if ('at_sender' in operation && operation.at_sender) {
          message = typeof message === 'string' ? [createMessage('text', { text: message })] : message
          message.unshift(createMessage('at', { qq: context.user_id.toString() }))
        }
        return await actionStrategy.send_msg!({
          message_type: context.message_type,
          group_id: context.group_id,
          user_id: context.user_id,
          message,
        })
      }
      if ('delete' in operation && operation.delete) {
        return await actionStrategy.delete_msg!({ message_id: context.message_id })
      }
      if ('kick' in operation && operation.kick) {
        return await actionStrategy.set_group_kick!({
          group_id: context.group_id,
          user_id: context.user_id,
          reject_add_request: false,
        })
      }
      if ('ban' in operation && operation.ban) {
        return await actionStrategy.set_group_ban!({
          group_id: context.group_id,
          user_id: context.user_id,
          duration: operation.ban_duration ?? 60 * 30,
        })
      }
    } else if (context.post_type === 'request') {
      const action = context.request_type === 'friend' ? 'set_friend_add_request' : 'set_group_add_request'
      return await actionStrategy[action]!({
        flag: context.flag,
        ...operation,
      })
    }
    return response(1000, { message: '事件对象不支持快速操作' })
  },
}

interface MessageData {
  message_id: number
}

interface MessageInfo {
  time: number
  message_type: 'private' | 'group'
  message_id: number
  real_id: number
  sender: GroupSender | PrivateSender
  message: Messages[]
}

interface StrangerInfo {
  reg_time: number
  user_id: number
  nickname: string
  sex: 'male' | 'female' | 'unknown'
  age: number
}

interface ErrorInfo {
  message: string
}

interface GroupInfo {
  group_id: number
  group_name: string
  member_count: number
  max_member_count: number
}

interface MemberInfo {
  reg_time: number
  group_id: number
  user_id: number
  nickname: string
  card: string
  sex: 'male' | 'female' | 'unknown'
  age: number
  area: string
  join_time: number
  last_sent_time: number
  level: string
  role: 'owner' | 'admin' | 'member'
  unfriendly: boolean
  title: string
  title_expire_time: number
  card_changeable: boolean
}

interface PrivateMessageQuickOperation {
  context: PrivateMessageEvent
  operation: {
    reply: string | Messages[]
    auto_escape: boolean
  }
}

interface GroupMessageQuickOperation {
  context: GroupMessageEvent
  operation: {
    reply: string | Messages[]
    auto_escape: boolean
    at_sender: boolean
    delete: boolean
    kick: boolean
    ban: boolean
    ban_duration: number
  }
}

interface FriendRequestQuickOperation {
  context: FriendRequestEvent
  operation: {
    approve: boolean
    remark: string
  }
}

interface GroupRequestQuickOperation {
  context: GroupRequestEvent
  operation: {
    approve: boolean
    reason: string
  }
}

function getGroupInfo(group: Group): GroupInfo {
  return {
    group_id: Number(group.id),
    group_name: group.name,
    member_count: group.memberCount,
    max_member_count: group.maxMemberCount,
  }
}

async function getMemberInfo(member: Member, role: 'owner' | 'admin' | 'member'): Promise<MemberInfo> {
  const chat = useChatStore()
  const lastSentTime = chat.chatLogs.findLast(chat => chat.type === 'message')?.scene.time
  const cardChangeable = role === 'owner' ? true : !!(role === 'admin' && member.role !== 'owner')
  const user = (await db.users.get(member.userId))!
  return {
    reg_time: Number(user.regTime),
    group_id: Number(member.groupId),
    user_id: Number(member.userId),
    nickname: user.name,
    card: member.card,
    role: member.role,
    level: member.level.toString(),
    title: member.title,
    title_expire_time: member.titleExpireTime,
    join_time: member.joinTime,
    last_sent_time: lastSentTime || 0,
    sex: user.sex,
    age: user.birthdate ? getUserAge(user.birthdate) : 0,
    area: user.location,
    unfriendly: false,
    card_changeable: cardChangeable,
  }
}

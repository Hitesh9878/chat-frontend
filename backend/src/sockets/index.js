// src/sockets/index.js - UPDATED WITH PERSISTENT INCOGNITO & AUTO-DELETION
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Message from '../models/Message.js';
import ChatRequest from '../models/ChatRequest.js';
import { sendNewMessageEmail } from '../services/emailService.js';

const userSockets = new Map();
const userActivity = new Map();

const getChatId = (userA, userB) => [userA, userB].sort().join('_');

const isUserInChat = (chatId, userId) => {
  const users = chatId.split('_');
  return users.includes(userId);
};

const areUsersFriends = async (userId1, userId2) => {
  const user = await User.findById(userId1);
  return user?.friends?.some(f => f.toString() === userId2.toString()) || false;
};

const isUserBlocked = async (userId, otherUserId) => {
  const user = await User.findById(userId);
  return user?.blockedUsers?.some(b => b.toString() === otherUserId.toString()) || false;
};

// ==================== INCOGNITO MODE HELPERS ====================

/**
 * Return incognito status for a chat considering BOTH users.
 * If either user has an active incognito for this chat, we treat it as enabled.
 * We use the EARLIEST expiry among active records to be conservative.
 */
const getIncognitoStatus = async (userId, otherUserId) => {
  const chatId = getChatId(userId, otherUserId);
  const [u1, u2] = await Promise.all([
    User.findById(userId),
    User.findById(otherUserId)
  ]);

  const now = new Date();

  const pickActive = (u) => {
    const ic = u?.incognitoChats?.find(ic => ic.chatId === chatId);
    if (!ic) return null;
    if (new Date(ic.expiresAt) <= now) return null;
    return ic;
  };

  const s1 = pickActive(u1);
  const s2 = pickActive(u2);

  if (!s1 && !s2) {
    // Also prune any expired records if present
    if (u1?.incognitoChats?.length) {
      u1.incognitoChats = u1.incognitoChats.filter(ic => !(ic.chatId === chatId && new Date(ic.expiresAt) <= now));
      await u1.save();
    }
    if (u2?.incognitoChats?.length) {
      u2.incognitoChats = u2.incognitoChats.filter(ic => !(ic.chatId === chatId && new Date(ic.expiresAt) <= now));
      await u2.save();
    }
    return { enabled: false, expiresAt: null, chatId };
  }

  // Use earliest expiry among active records for stricter deletion
  const expiresAt = new Date(
    Math.min(
      s1 ? new Date(s1.expiresAt).getTime() : Infinity,
      s2 ? new Date(s2.expiresAt).getTime() : Infinity
    )
  );

  return { enabled: true, expiresAt, chatId };
};

/**
 * Schedule message deletion for incognito mode
 */
const scheduleMessageDeletion = (io, messageId, chatId, deleteAfterMs) => {
  setTimeout(async () => {
    try {
      const deletedMessage = await Message.findByIdAndDelete(messageId);
      if (deletedMessage) {
        console.log(`🕵️ [INCOGNITO] Auto-deleted message: ${messageId} from chat: ${chatId}`);
        io.to(chatId).emit('messageDeleted', { messageId, chatId, reason: 'incognito' });
      }
    } catch (error) {
      console.error('❌ [INCOGNITO] Failed to delete message:', error);
    }
  }, Math.max(0, deleteAfterMs));
};

/**
 * Clean up expired incognito chats and messages (runs periodically)
 * If a chat's incognito has expired, delete all its messages and strip the incognito records.
 */
const cleanupExpiredIncognitoChats = async (io) => {
  try {
    const now = new Date();

    const users = await User.find({ 'incognitoChats.0': { $exists: true } });

    for (const user of users) {
      const expiredForUser = user.incognitoChats?.filter(ic => new Date(ic.expiresAt) <= now) || [];
      if (!expiredForUser.length) continue;

      // Deduplicate by chatId so we don't repeat work
      const expiredChatIds = [...new Set(expiredForUser.map(ic => ic.chatId))];

      for (const chatId of expiredChatIds) {
        console.log(`🕵️ [INCOGNITO] Cleaning expired chat: ${chatId}`);

        // Delete all messages in this chat
        const deletedMessages = await Message.deleteMany({ chatId });
        console.log(`🗑️ [INCOGNITO] Deleted ${deletedMessages.deletedCount} messages from ${chatId}`);

        // Notify connected users
        io.to(chatId).emit('chatCleared', {
          chatId,
          reason: 'incognito_expired'
        });
      }

      // Remove expired incognito chats from this user
      user.incognitoChats = user.incognitoChats.filter(ic => new Date(ic.expiresAt) > now);
      await user.save();
    }
  } catch (error) {
    console.error('❌ [INCOGNITO] Cleanup error:', error);
  }
};

export const initializeSocket = (io) => {
  console.log("🚀 Socket server starting...");

  // Start periodic cleanup (every 5 minutes)
  setInterval(() => cleanupExpiredIncognitoChats(io), 5 * 60 * 1000);
  console.log("🕵️ [INCOGNITO] Periodic cleanup started (every 5 minutes)");

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('No token provided'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user) return next(new Error('User not found'));

      socket.user = user;
      next();
    } catch (err) {
      console.error('Auth error:', err.message);
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user._id.toString();
    const userName = socket.user.name;
    const userStatus = socket.user.status || 'online';

    console.log(`✅ User connected: ${userName} (${userId}) - Status: ${userStatus}`);
    userSockets.set(userId, socket.id);

    userActivity.set(userId, {
      sessionStart: new Date(),
      lastActivity: new Date()
    });

    try {
      await User.findByIdAndUpdate(userId, {
        isOnline: true,
        lastSeen: new Date()
      });

      io.emit('userStatus', {
        userId,
        isOnline: true,
        status: userStatus
      });

      // Load pending chat requests
      const pendingRequests = await ChatRequest.find({
        $or: [{ sender: userId }, { receiver: userId }],
        status: 'pending'
      })
        .populate('sender', 'name email avatar')
        .populate('receiver', 'name email avatar');

      const received = pendingRequests.filter(r => r.receiver._id.toString() === userId);
      const sent = pendingRequests.filter(r => r.sender._id.toString() === userId);

      socket.emit('chatRequestsLoaded', {
        received,
        sent,
        count: received.length
      });

      // Check for offline messages
      const offlineMessages = await Message.find({
        $or: [
          { chatId: { $regex: `_${userId}$` } },
          { chatId: { $regex: `^${userId}_` } }
        ],
        sender: { $ne: userId },
      }).populate('sender', 'name avatar');

      if (offlineMessages.length > 0) {
        console.log(`📬 User ${userName} has ${offlineMessages.length} offline messages`);

        const groupedByChat = {};
        offlineMessages.forEach(msg => {
          if (!groupedByChat[msg.chatId]) {
            groupedByChat[msg.chatId] = [];
          }
          groupedByChat[msg.chatId].push(msg);
        });

        socket.emit('offlineMessagesNotification', {
          count: offlineMessages.length,
          chats: groupedByChat,
          message: `You have ${offlineMessages.length} new message(s) while you were offline`
        });
      }

      // Mark undelivered messages as delivered
      const undeliveredMessages = await Message.find({
        $or: [
          { chatId: { $regex: `_${userId}$` } },
          { chatId: { $regex: `^${userId}_` } }
        ],
        sender: { $ne: userId },
        isDelivered: false
      });

      for (const msg of undeliveredMessages) {
        if (isUserInChat(msg.chatId, userId)) {
          msg.isDelivered = true;
          msg.deliveredAt = new Date();
          await msg.save();

          const senderSocketId = userSockets.get(msg.sender.toString());
          if (senderSocketId) {
            io.to(senderSocketId).emit('messageDelivered', {
              messageId: msg._id,
              deliveredAt: msg.deliveredAt,
              chatId: msg.chatId
            });
          }
        }
      }

    } catch (error) {
      console.error('Error updating user status on connection:', error);
    }

    // ==================== GET INCOGNITO STATUS ====================

    socket.on('getIncognitoStatus', async (data) => {
      try {
        const { otherUserId } = data;
        const chatId = getChatId(userId, otherUserId);

        const status = await getIncognitoStatus(userId, otherUserId);

        socket.emit('incognitoStatus', {
          chatId,
          enabled: status.enabled,
          expiresAt: status.expiresAt
        });

        console.log(`🕵️ [INCOGNITO] Status requested for ${chatId}:`, status);
      } catch (error) {
        console.error('Error getting incognito status:', error);
      }
    });

    // ==================== TOGGLE INCOGNITO MODE ====================

    socket.on('toggleIncognito', async (data) => {
      try {
        const { otherUserId, enabled, durationHours = 3 } = data;
        const chatId = getChatId(userId, otherUserId);

        const [me, them] = await Promise.all([
          User.findById(userId),
          User.findById(otherUserId)
        ]);

        if (!me || !them) {
          socket.emit('incognitoError', { message: 'User not found' });
          return;
        }

        if (enabled) {
          const INCOGNITO_DURATION_HOURS = durationHours;
          const expiresAt = new Date(Date.now() + INCOGNITO_DURATION_HOURS * 60 * 60 * 1000);

          // Ensure arrays exist
          me.incognitoChats = me.incognitoChats || [];
          them.incognitoChats = them.incognitoChats || [];

          // Remove any existing incognito setting for this chat for both users
          me.incognitoChats = me.incognitoChats.filter(ic => ic.chatId !== chatId);
          them.incognitoChats = them.incognitoChats.filter(ic => ic.chatId !== chatId);

          // Add new incognito setting for BOTH users
          const record = { chatId, enabledAt: new Date(), expiresAt };
          me.incognitoChats.push(record);
          them.incognitoChats.push(record);

          await Promise.all([me.save(), them.save()]);

          // Notify both users
          socket.emit('incognitoEnabled', {
            chatId,
            expiresAt,
            message: `Incognito mode enabled. Messages will auto-delete after ${INCOGNITO_DURATION_HOURS} hours.`
          });

          const otherUserSocketId = userSockets.get(otherUserId);
          if (otherUserSocketId) {
            io.to(otherUserSocketId).emit('incognitoEnabled', {
              chatId,
              expiresAt,
              message: `${me.name} enabled incognito mode for this chat.`
            });
          }

          console.log(`🕵️ [INCOGNITO] Enabled for chat ${chatId} by ${me.name}, expires at ${expiresAt}`);

          // Schedule deletion of all existing messages in this chat
          const existingMessages = await Message.find({ chatId });
          const deleteAfterMs = expiresAt - new Date();

          for (const msg of existingMessages) {
            scheduleMessageDeletion(io, msg._id, chatId, deleteAfterMs);
          }
          console.log(`🕵️ [INCOGNITO] Scheduled deletion for ${existingMessages.length} existing messages`);
        } else {
          // Disable incognito mode for BOTH users
          me.incognitoChats = (me.incognitoChats || []).filter(ic => ic.chatId !== chatId);
          them.incognitoChats = (them.incognitoChats || []).filter(ic => ic.chatId !== chatId);

          await Promise.all([me.save(), them.save()]);

          socket.emit('incognitoDisabled', {
            chatId,
            message: 'Incognito mode disabled. Messages will no longer auto-delete.'
          });

          const otherUserSocketId = userSockets.get(otherUserId);
          if (otherUserSocketId) {
            io.to(otherUserSocketId).emit('incognitoDisabled', {
              chatId,
              message: `${me.name} disabled incognito mode for this chat.`
            });
          }

          console.log(`👁️ [INCOGNITO] Disabled for chat ${chatId} by ${me.name}`);
        }

      } catch (error) {
        console.error('Error toggling incognito:', error);
        socket.emit('incognitoError', { message: 'Failed to toggle incognito mode' });
      }
    });

    // ==================== CHAT REQUEST HANDLERS ====================

    socket.on('sendChatRequest', async (data) => {
      try {
        const { receiverId } = data;

        const areFriends = await areUsersFriends(userId, receiverId);
        if (areFriends) {
          socket.emit('chatRequestError', { message: 'Already friends with this user' });
          return;
        }

        const blocked = await isUserBlocked(receiverId, userId);
        if (blocked) {
          socket.emit('chatRequestError', { message: 'Cannot send request to this user' });
          return;
        }

        const existingRequest = await ChatRequest.findOne({
          $or: [
            { sender: userId, receiver: receiverId, status: 'pending' },
            { sender: receiverId, receiver: userId, status: 'pending' }
          ]
        });

        if (existingRequest) {
          socket.emit('chatRequestError', { message: 'Chat request already exists' });
          return;
        }

        const chatRequest = await ChatRequest.create({
          sender: userId,
          receiver: receiverId,
          status: 'pending'
        });

        await chatRequest.populate('sender', 'name email avatar');
        await chatRequest.populate('receiver', 'name email avatar');

        const receiverSocketId = userSockets.get(receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('newChatRequest', chatRequest);
        }

        socket.emit('chatRequestSent', chatRequest);
        console.log(`📨 Chat request sent from ${userName} to ${receiverId}`);

      } catch (error) {
        console.error('Error sending chat request:', error);
        socket.emit('chatRequestError', { message: 'Failed to send chat request' });
      }
    });

    socket.on('acceptChatRequest', async (data) => {
      try {
        const { requestId } = data;

        const chatRequest = await ChatRequest.findById(requestId);
        if (!chatRequest) {
          socket.emit('chatRequestError', { message: 'Request not found' });
          return;
        }

        if (chatRequest.receiver.toString() !== userId) {
          socket.emit('chatRequestError', { message: 'Unauthorized' });
          return;
        }

        chatRequest.status = 'accepted';
        await chatRequest.save();

        await User.findByIdAndUpdate(userId, {
          $addToSet: { friends: chatRequest.sender }
        });

        await User.findByIdAndUpdate(chatRequest.sender, {
          $addToSet: { friends: userId }
        });

        await chatRequest.populate('sender', 'name email avatar');
        await chatRequest.populate('receiver', 'name email avatar');

        const senderSocketId = userSockets.get(chatRequest.sender._id.toString());
        if (senderSocketId) {
          io.to(senderSocketId).emit('chatRequestAccepted', chatRequest);
        }

        socket.emit('chatRequestAccepted', chatRequest);
        console.log(`✅ Chat request accepted: ${requestId}`);

      } catch (error) {
        console.error('Error accepting chat request:', error);
        socket.emit('chatRequestError', { message: 'Failed to accept request' });
      }
    });

    socket.on('rejectChatRequest', async (data) => {
      try {
        const { requestId } = data;

        const chatRequest = await ChatRequest.findById(requestId);
        if (!chatRequest) {
          socket.emit('chatRequestError', { message: 'Request not found' });
          return;
        }

        if (chatRequest.receiver.toString() !== userId) {
          socket.emit('chatRequestError', { message: 'Unauthorized' });
          return;
        }

        chatRequest.status = 'rejected';
        await chatRequest.save();

        const senderSocketId = userSockets.get(chatRequest.sender.toString());
        if (senderSocketId) {
          io.to(senderSocketId).emit('chatRequestRejected', { requestId });
        }

        socket.emit('chatRequestRejected', { requestId });
        console.log(`❌ Chat request rejected: ${requestId}`);

      } catch (error) {
        console.error('Error rejecting chat request:', error);
        socket.emit('chatRequestError', { message: 'Failed to reject request' });
      }
    });

    socket.on('cancelChatRequest', async (data) => {
      try {
        const { requestId } = data;

        const chatRequest = await ChatRequest.findById(requestId);
        if (!chatRequest) {
          socket.emit('chatRequestError', { message: 'Request not found' });
          return;
        }

        if (chatRequest.sender.toString() !== userId) {
          socket.emit('chatRequestError', { message: 'Unauthorized' });
          return;
        }

        await ChatRequest.findByIdAndDelete(requestId);

        const receiverSocketId = userSockets.get(chatRequest.receiver.toString());
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('chatRequestCancelled', { requestId });
        }

        socket.emit('chatRequestCancelled', { requestId });
        console.log(`🗑️ Chat request cancelled: ${requestId}`);

      } catch (error) {
        console.error('Error cancelling chat request:', error);
        socket.emit('chatRequestError', { message: 'Failed to cancel request' });
      }
    });

    // ==================== BLOCK/UNBLOCK USER ====================

    socket.on('blockUser', async (data) => {
      try {
        const { userIdToBlock } = data;

        await User.findByIdAndUpdate(userId, {
          $addToSet: { blockedUsers: userIdToBlock },
          $pull: { friends: userIdToBlock }
        });

        await User.findByIdAndUpdate(userIdToBlock, {
          $pull: { friends: userId }
        });

        socket.emit('userBlocked', { userId: userIdToBlock });
        console.log(`🚫 User ${userName} blocked ${userIdToBlock}`);

      } catch (error) {
        console.error('Error blocking user:', error);
        socket.emit('blockUserError', { message: 'Failed to block user' });
      }
    });

    socket.on('unblockUser', async (data) => {
      try {
        const { userIdToUnblock } = data;

        await User.findByIdAndUpdate(userId, {
          $pull: { blockedUsers: userIdToUnblock }
        });

        socket.emit('userUnblocked', { userId: userIdToUnblock });
        console.log(`✅ User ${userName} unblocked ${userIdToUnblock}`);

      } catch (error) {
        console.error('Error unblocking user:', error);
        socket.emit('unblockUserError', { message: 'Failed to unblock user' });
      }
    });

    // ==================== REMOVE FRIEND ====================

    socket.on('removeFriend', async (data) => {
      try {
        const { friendId } = data;

        await User.findByIdAndUpdate(userId, {
          $pull: { friends: friendId }
        });

        await User.findByIdAndUpdate(friendId, {
          $pull: { friends: userId }
        });

        socket.emit('friendRemoved', { userId: friendId });

        const friendSocketId = userSockets.get(friendId);
        if (friendSocketId) {
          io.to(friendSocketId).emit('friendRemoved', { userId });
        }

        console.log(`🔄 User ${userName} removed friend ${friendId}`);

      } catch (error) {
        console.error('Error removing friend:', error);
        socket.emit('removeFriendError', { message: 'Failed to remove friend' });
      }
    });

    // ==================== MESSAGE HANDLERS ====================

    socket.on('joinChat', (chatId) => {
      console.log(`📌 User ${userName} joined chat room ${chatId}`);
      socket.join(chatId);
    });

    socket.on('loadMessages', async (data) => {
      try {
        const { otherUserId } = data;
        const chatId = getChatId(userId, otherUserId);

        const areFriends = await areUsersFriends(userId, otherUserId);
        if (!areFriends) {
          socket.emit('messagesLoadError', {
            message: 'You must be friends to view messages',
            requiresFriendship: true
          });
          return;
        }

        const blocked = await isUserBlocked(userId, otherUserId);
        const blockedBy = await isUserBlocked(otherUserId, userId);

        if (blocked || blockedBy) {
          socket.emit('messagesLoadError', {
            message: 'Cannot load messages',
            isBlocked: true
          });
          return;
        }

        console.log(`📚 Loading messages for chat: ${chatId}`);

        // << INSERTED: populate reactions.userId >>
        const messages = await Message.find({ chatId })
          .populate('sender', 'name avatar')
          .populate('reactions.userId', 'name avatar')  // CRITICAL
          .sort({ createdAt: 1 })
          .limit(50);

        const messagesWithStatus = messages.map(msg => ({
          _id: msg._id,
          sender: msg.sender,
          chatId: msg.chatId,
          messageType: msg.messageType,
          content: msg.content,
          createdAt: msg.createdAt,
          isDelivered: msg.isDelivered || false,
          isRead: msg.isRead || false,
          deliveredAt: msg.deliveredAt,
          readAt: msg.readAt,
          reactions: msg.reactions,
          replyTo: msg.replyTo
        }));

        socket.emit('messagesLoaded', {
          chatId,
          messages: messagesWithStatus
        });

        console.log(`📚 Sent ${messagesWithStatus.length} messages for chat ${chatId}`);
      } catch (error) {
        console.error('Error loading messages:', error);
        socket.emit('messagesLoadError', { message: 'Failed to load messages' });
      }
    });

    socket.on('sendMessage', async (data) => {
      console.log(`📨 Message from ${userName}:`, data);

      if (userActivity.has(userId)) {
        userActivity.get(userId).lastActivity = new Date();
      }

      try {
        const { receiverId, content, tempId, messageType = 'text', replyTo } = data;
        if (!receiverId || !content) {
          socket.emit('sendMessageError', { message: 'Invalid message data', tempId });
          return;
        }

        const areFriends = await areUsersFriends(userId, receiverId);
        if (!areFriends) {
          socket.emit('sendMessageError', {
            message: 'You must be friends to send messages',
            tempId,
            requiresFriendship: true
          });
          return;
        }

        const blocked = await isUserBlocked(userId, receiverId);
        const blockedBy = await isUserBlocked(receiverId, userId);

        if (blocked || blockedBy) {
          socket.emit('sendMessageError', {
            message: 'Cannot send message',
            tempId,
            isBlocked: true
          });
          return;
        }

        const chatId = getChatId(userId, receiverId);

        const receiverSocketId = userSockets.get(receiverId);
        const isRecipientOnline = !!receiverSocketId;

        // Ensure reactions array exists when creating
        const message = await Message.create({
          sender: userId,
          chatId,
          messageType,
          content,
          isDelivered: isRecipientOnline,
          isRead: false,
          deliveredAt: isRecipientOnline ? new Date() : null,
          readAt: null,
          reactions: [],
          ...(replyTo ? { replyTo } : {}) // pass through if your schema supports it
        });

        await message.populate('sender', 'name avatar');

        const messageObj = {
          _id: message._id,
          sender: message.sender,
          chatId: chatId,
          messageType: message.messageType,
          content: message.content,
          createdAt: message.createdAt,
          tempId,
          isDelivered: message.isDelivered,
          isRead: message.isRead,
          deliveredAt: message.deliveredAt,
          readAt: message.readAt,
          replyTo: message.replyTo
        };

        io.to(chatId).emit('receiveMessage', messageObj);

        if (receiverSocketId) {
          const receiverPayload = {
            ...messageObj,
            receiverId: receiverId,
            forSidebar: true,
            isForReceiver: true,
            isForSender: false
          };

          io.to(receiverSocketId).emit('newMessageForSidebar', receiverPayload);
        } else {
          try {
            const recipient = await User.findById(receiverId);
            if (recipient && recipient.email) {
              await sendNewMessageEmail(recipient.email, userName);
            }
          } catch (emailError) {
            console.error('Email notification failed:', emailError);
          }
        }

        const senderPayload = {
          ...messageObj,
          receiverId: receiverId,
          forSidebar: true,
          isForReceiver: false,
          isForSender: true
        };

        socket.emit('newMessageForSidebar', senderPayload);

        socket.emit('messageSent', {
          messageId: message._id,
          tempId,
          success: true,
          isDelivered: message.isDelivered,
          deliveredAt: message.deliveredAt
        });

        if (isRecipientOnline) {
          socket.emit('messageDelivered', {
            messageId: message._id,
            deliveredAt: message.deliveredAt,
            chatId: chatId
          });
        }

        // ✅ CHECK AND SCHEDULE INCOGNITO DELETION (consider both users)
        const incognitoStatus = await getIncognitoStatus(userId, receiverId);

        if (incognitoStatus.enabled) {
          const deleteAfterMs = new Date(incognitoStatus.expiresAt) - new Date();

          if (deleteAfterMs > 0) {
            scheduleMessageDeletion(io, message._id, chatId, deleteAfterMs);
            console.log(`🕵️ [INCOGNITO] Scheduled deletion for message ${message._id} in ${Math.round(deleteAfterMs / 1000 / 60)} minutes`);
          }
        }

      } catch (error) {
        console.error('❌ Send message error:', error);
        socket.emit('sendMessageError', {
          message: 'Failed to send message: ' + error.message,
          tempId: data.tempId
        });
      }
    });

    socket.on('typing', (data) => {
      const { chatId } = data;
      if (!chatId) return;
      io.to(chatId).emit('typing', {
        userId: userId,
        userName: userName,
        chatId: chatId
      });
    });

    socket.on('stopTyping', (data) => {
      const { chatId } = data;
      if (!chatId) return;
      io.to(chatId).emit('stopTyping', {
        userId: userId,
        chatId: chatId
      });
    });

    socket.on('markMessageAsRead', async (data) => {
      try {
        const { messageId } = data;

        const message = await Message.findById(messageId);
        if (!message || !isUserInChat(message.chatId, userId)) return;

        if (!message.isRead) {
          const updatedMessage = await Message.findByIdAndUpdate(
            messageId,
            { isRead: true, readAt: new Date() },
            { new: true }
          );

          if (updatedMessage) {
            io.to(message.chatId).emit('messageRead', {
              messageId,
              readAt: updatedMessage.readAt,
              chatId: message.chatId,
              readBy: userId
            });
          }
        }
      } catch (error) {
        console.error('❌ Error marking message as read:', error);
      }
    });

    socket.on('markChatAsRead', async (data) => {
      try {
        const { otherUserId } = data;
        const chatId = getChatId(userId, otherUserId);

        const result = await Message.updateMany(
          { chatId, sender: otherUserId, isRead: false },
          { isRead: true, readAt: new Date() }
        );

        if (result.modifiedCount > 0) {
          io.to(chatId).emit('chatRead', {
            chatId,
            readAt: new Date(),
            readCount: result.modifiedCount,
            readBy: userId
          });
        }
      } catch (error) {
        console.error('❌ Error marking chat as read:', error);
      }
    });

    socket.on('clearChat', async (data) => {
      try {
        const { otherUserId } = data;
        const chatId = getChatId(userId, otherUserId);

        await Message.deleteMany({ chatId });

        io.to(chatId).emit('chatCleared', { chatId });
        socket.emit('chatClearSuccess', { chatId });

      } catch (error) {
        console.error('Error clearing chat:', error);
        socket.emit('chatClearError', { message: 'Failed to clear chat' });
      }
    });

    socket.on('updateStatus', async (data) => {
      try {
        const { status } = data;
        const validStatuses = ['online', 'away', 'busy', 'offline'];

        if (!validStatuses.includes(status)) {
          socket.emit('statusUpdateError', { message: 'Invalid status' });
          return;
        }

        const user = await User.findByIdAndUpdate(userId, { status }, { new: true });

        console.log(`🔄 User ${userName} status updated to: ${status}`);

        io.emit('userStatus', {
          userId,
          isOnline: user.isOnline,
          status: user.status,
          lastSeen: user.lastSeen
        });

        socket.emit('statusUpdateSuccess', { status: user.status });
      } catch (error) {
        console.error('Error updating status:', error);
        socket.emit('statusUpdateError', { message: 'Failed to update status' });
      }
    });

    socket.on('userActivity', () => {
      if (userActivity.has(userId)) {
        userActivity.get(userId).lastActivity = new Date();
      }
    });

    // ==================== REACTIONS ====================

    socket.on('addReaction', async ({ messageId, emoji }) => {
      try {
        console.log('😊 [SOCKET] Adding reaction:', { messageId, emoji, userId });

        const message = await Message.findById(messageId);
        if (!message) {
          socket.emit('reactionError', { message: 'Message not found' });
          return;
        }

        if (!Array.isArray(message.reactions)) {
          message.reactions = [];
        }

        // Check if user already reacted with this emoji
        const existingReactionIndex = message.reactions.findIndex(
          r => r.userId.toString() === userId && r.emoji === emoji
        );

        if (existingReactionIndex !== -1) {
          // Remove reaction if already exists (toggle off)
          message.reactions.splice(existingReactionIndex, 1);
          console.log('🗑️ [SOCKET] Removed existing reaction');
        } else {
          // Remove any other reaction from this user (only one reaction per user)
          message.reactions = message.reactions.filter(
            r => r.userId.toString() !== userId
          );

          // Add new reaction
          message.reactions.push({
            userId: userId,
            emoji: emoji,
            createdAt: new Date()
          });
          console.log('✅ [SOCKET] Added new reaction');
        }

        await message.save();

        // Populate user data for reactions
        await message.populate('reactions.userId', 'name avatar');

        const reactionData = {
          messageId: message._id,
          reactions: message.reactions,
          chatId: message.chatId
        };

        // Emit to current user
        socket.emit('reactionUpdated', reactionData);

        // Emit to other users in the chat
        socket.to(message.chatId).emit('reactionUpdated', reactionData);

        console.log('✅ [SOCKET] Reaction updated successfully');

      } catch (error) {
        console.error('❌ [SOCKET] Error adding reaction:', error);
        socket.emit('reactionError', { message: 'Failed to add reaction' });
      }
    });

    socket.on('removeReaction', async ({ messageId }) => {
      try {
        console.log('🗑️ [SOCKET] Removing reaction:', { messageId, userId });

        const message = await Message.findById(messageId);
        if (!message) {
          socket.emit('reactionError', { message: 'Message not found' });
          return;
        }

        if (!Array.isArray(message.reactions)) {
          message.reactions = [];
        }

        // Remove user's reaction
        message.reactions = message.reactions.filter(
          r => r.userId.toString() !== userId
        );

        await message.save();
        await message.populate('reactions.userId', 'name avatar');

        const reactionData = {
          messageId: message._id,
          reactions: message.reactions,
          chatId: message.chatId
        };

        // Emit to current user
        socket.emit('reactionUpdated', reactionData);

        // Emit to other users in the chat
        socket.to(message.chatId).emit('reactionUpdated', reactionData);

        console.log('✅ [SOCKET] Reaction removed successfully');

      } catch (error) {
        console.error('❌ [SOCKET] Error removing reaction:', error);
        socket.emit('reactionError', { message: 'Failed to remove reaction' });
      }
    });

    socket.on('disconnect', async () => {
      console.log(`❌ User disconnected: ${userName}`);

      const activity = userActivity.get(userId);
      if (activity) userActivity.delete(userId);

      userSockets.delete(userId);

      try {
        await User.findByIdAndUpdate(userId, {
          isOnline: false,
          lastSeen: new Date()
        });

        io.emit('userStatus', {
          userId,
          isOnline: false,
          lastSeen: new Date()
        });
      } catch (error) {
        console.error('Error on disconnect:', error);
      }
    });
  });
};

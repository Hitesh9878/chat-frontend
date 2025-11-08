import React, { useState, useRef, useEffect, useContext } from 'react';
import { Check, CheckCheck, Download, Mic, Smile, Reply, X } from 'lucide-react';
import EmojiPicker from 'emoji-picker-react';
import { SocketContext } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import './MessageBubble.css';

const MessageBubble = ({ message, isSender, onReply }) => {
    const [showReactionPicker, setShowReactionPicker] = useState(false);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [reactionPickerPosition, setReactionPickerPosition] = useState('default');
    const [showMobileActions, setShowMobileActions] = useState(false);
    
    const reactionPickerRef = useRef(null);
    const reactionButtonRef = useRef(null);
    const reactionsBarRef = useRef(null);
    const emojiPickerRef = useRef(null);
    const messageBubbleRef = useRef(null);
    const mobileActionsRef = useRef(null);
    
    const socket = useContext(SocketContext);
    const { user } = useAuth();
    const currentUserId = user?._id;

    const timestamp = message?.createdAt ? new Date(message.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    }) : '';

    const wrapperClasses = `message-bubble-wrapper ${isSender ? 'sender' : 'receiver'}`;
    const bubbleClasses = `message-bubble ${isSender ? 'sender' : 'receiver'} ${showMobileActions ? 'mobile-actions-active' : ''}`;

    // Quick reactions for the simple picker
    const quickReactions = ['❤️', '😂', '😮', '😢', '😡', '👍'];

    // Close reaction picker when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            // Don't close if clicking on mobile actions
            if (mobileActionsRef.current && mobileActionsRef.current.contains(event.target)) {
                return;
            }

            if (
                (reactionPickerRef.current && !reactionPickerRef.current.contains(event.target)) &&
                (reactionButtonRef.current && !reactionButtonRef.current.contains(event.target)) &&
                (reactionsBarRef.current && !reactionsBarRef.current.contains(event.target)) &&
                (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) &&
                (messageBubbleRef.current && !messageBubbleRef.current.contains(event.target))
            ) {
                setShowReactionPicker(false);
                setShowEmojiPicker(false);
                setReactionPickerPosition('default');
                setShowMobileActions(false);
            }
        };

        if (showReactionPicker || showEmojiPicker || showMobileActions) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('touchstart', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('touchstart', handleClickOutside);
        };
    }, [showReactionPicker, showEmojiPicker, showMobileActions]);

    // Handle file download
    const handleDownload = (fileUrl, fileName) => {
        const link = document.createElement('a');
        link.href = fileUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // Handle adding/removing reaction
    const handleReaction = (emoji) => {
        if (!socket || !message._id || !currentUserId) {
            console.log('⚠️ [MESSAGE BUBBLE] Cannot add reaction: missing socket, message._id, or currentUserId');
            return;
        }

        console.log('😊 [MESSAGE BUBBLE] Adding/removing reaction:', {
            emoji,
            messageId: message._id,
            userId: currentUserId
        });

        // Check if user already reacted with this emoji
        const existingReaction = message.reactions?.find(
            r => r.userId?._id === currentUserId && r.emoji === emoji
        );

        if (existingReaction) {
            // Remove reaction (toggle off)
            console.log('🗑️ [MESSAGE BUBBLE] Removing existing reaction');
            socket.emit('removeReaction', { messageId: message._id });
        } else {
            // Add reaction
            console.log('➕ [MESSAGE BUBBLE] Adding new reaction');
            socket.emit('addReaction', { messageId: message._id, emoji });
        }

        setShowReactionPicker(false);
        setShowEmojiPicker(false);
        setReactionPickerPosition('default');
        setShowMobileActions(false);
    };

    // Handle emoji picker selection
    const handleEmojiPickerSelect = (emojiObject) => {
        handleReaction(emojiObject.emoji);
    };

    // Get reaction counts grouped by emoji
    const getReactionCounts = () => {
        if (!message.reactions || message.reactions.length === 0) return {};

        return message.reactions.reduce((acc, reaction) => {
            if (!acc[reaction.emoji]) {
                acc[reaction.emoji] = {
                    count: 0,
                    users: []
                };
            }
            acc[reaction.emoji].count++;
            acc[reaction.emoji].users.push(reaction.userId);
            return acc;
        }, {});
    };

    // Check if current user reacted with specific emoji
    const hasUserReacted = (emoji) => {
        if (!currentUserId || !message.reactions) return false;
        return message.reactions.some(
            r => r.userId?._id === currentUserId && r.emoji === emoji
        );
    };

    // Handle mobile bubble click
    const handleBubbleClick = (e) => {
        // Only handle mobile touch events
        if (window.innerWidth <= 768) {
            e.stopPropagation();
            setShowMobileActions(!showMobileActions);
            setShowReactionPicker(false);
            setShowEmojiPicker(false);
        }
    };

    // Render message status with better colors
    const renderMessageStatus = () => {
        // Only show status for sender's messages
        if (!isSender) return null;

        // Handle different message states
        if (message?.isOptimistic) {
            return (
                <span className="message-status optimistic" title="Sending...">
                    <Check size={14} />
                    <span className="status-text">Sending...</span>
                </span>
            );
        }
        
        if (message?.failed) {
            return (
                <span className="message-status failed" title="Failed">
                    <X size={14} />
                    <span className="status-text">Failed</span>
                </span>
            );
        }

        // Message status based on delivery and read status
        const isDelivered = message?.isDelivered === true;
        const isRead = message?.isRead === true;

        if (isRead) {
            return (
                <span className="message-status read" title="Read">
                    <CheckCheck size={14} />
                    <span className="status-text"></span>
                </span>
            );
        } else if (isDelivered) {
            return (
                <span className="message-status delivered" title="Delivered">
                    <CheckCheck size={14} />
                    <span className="status-text"></span>
                </span>
            );
        } else {
            return (
                <span className="message-status sent" title="Sent">
                    <Check size={14} />
                    <span className="status-text"></span>
                </span>
            );
        }
    };

    const renderMessageContent = () => {
        const messageType = message.messageType || 'text';
        const { content } = message;

        switch (messageType) {
            case 'image':
                return (
                    <>
                        <div className="message-image-container">
                            <img 
                                src={content.fileUrl} 
                                alt={content.fileName || 'image attachment'} 
                                className="message-image" 
                            />
                            <button
                                className="download-btn"
                                onClick={() => handleDownload(content.fileUrl, content.fileName || 'image.jpg')}
                                title="Download image"
                            >
                                <Download size={16} />
                            </button>
                        </div>
                        <div className="message-time-inline">
                            <span className="message-time">{timestamp}</span>
                            {renderMessageStatus()}
                        </div>
                    </>
                );
            
            case 'video':
                return (
                    <>
                        <div className="message-video-container">
                            <video 
                                src={content.fileUrl} 
                                controls 
                                className="message-video"
                            />
                            <button
                                className="download-btn"
                                onClick={() => handleDownload(content.fileUrl, content.fileName || 'video.mp4')}
                                title="Download video"
                            >
                                <Download size={16} />
                            </button>
                        </div>
                        <div className="message-time-inline">
                            <span className="message-time">{timestamp}</span>
                            {renderMessageStatus()}
                        </div>
                    </>
                );
            
            case 'voice':
                return (
                    <>
                        <div className="message-voice-container">
                            <Mic size={20} className="voice-icon" />
                            <audio 
                                src={content.fileUrl} 
                                controls 
                                className="message-audio"
                            />
                            <button
                                className="download-btn"
                                onClick={() => handleDownload(content.fileUrl, content.fileName || 'voice.mp3')}
                                title="Download voice message"
                            >
                                <Download size={16} />
                            </button>
                        </div>
                        <div className="message-time-inline">
                            <span className="message-time">{timestamp}</span>
                            {renderMessageStatus()}
                        </div>
                    </>
                );
            
            case 'file':
                return (
                    <>
                        <div className="message-file-container">
                            <a 
                                href={content.fileUrl} 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="message-file"
                            >
                                📄 <span>{content.fileName || 'View File'}</span>
                            </a>
                            <button
                                className="download-btn"
                                onClick={() => handleDownload(content.fileUrl, content.fileName || 'file')}
                                title="Download file"
                            >
                                <Download size={16} />
                            </button>
                        </div>
                        <div className="message-time-inline">
                            <span className="message-time">{timestamp}</span>
                            {renderMessageStatus()}
                        </div>
                    </>
                );
            
            default: // 'text'
                return (
                    <>
                        <div className="message-text">{content.text}</div>
                        <div className="message-time-inline">
                            <span className="message-time">{timestamp}</span>
                            {renderMessageStatus()}
                        </div>
                    </>
                );
        }
    };

    const reactionCounts = getReactionCounts();

    return (
        <div className={wrapperClasses}>
            <div className="message-bubble-container" ref={messageBubbleRef}>
                {/* Reply preview - Show ABOVE the message bubble */}
                {message.replyTo && (
                    <div className={`reply-reference ${isSender ? 'sender' : 'receiver'}`}>
                        <div className="reply-reference-line"></div>
                        <div className="reply-reference-content">
                            <span className="reply-reference-sender">
                                {message.replyTo.sender?.name || 'Unknown'}
                            </span>
                            <span className="reply-reference-text">
                                {message.replyTo.content?.text?.substring(0, 50) || 'Message'}
                                {message.replyTo.content?.text?.length > 50 ? '...' : ''}
                            </span>
                        </div>
                    </div>
                )}

                <div className="bubble-with-reply">
                    <div 
                        className={bubbleClasses}
                        onClick={handleBubbleClick}
                    >
                        <div className="message-content-wrapper">
                            {renderMessageContent()}
                        </div>
                    </div>

                    {/* Permanent Reply Button - Always visible */}
                    {!message.isOptimistic && (
                        <button
                            className="permanent-reply-btn"
                            onClick={() => {
                                onReply && onReply(message);
                                setShowMobileActions(false);
                            }}
                            title="Reply to message"
                        >
                            <Reply size={16} />
                        </button>
                    )}
                </div>

                {/* Desktop Action Buttons Container - Now only for reactions */}
                {!message.isOptimistic && (
                    <div className="message-actions">
                        {/* Reaction Button */}
                        <button
                            ref={reactionButtonRef}
                            className="message-action-btn reaction-trigger-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                console.log('🖱️ [MESSAGE BUBBLE] Reaction button clicked');
                                setShowReactionPicker(!showReactionPicker);
                                setShowEmojiPicker(false);
                                setReactionPickerPosition('default');
                                setShowMobileActions(false);
                            }}
                            title="Add reaction"
                        >
                            <Smile size={16} />
                        </button>
                    </div>
                )}

                {/* Mobile Action Buttons - Positioned outside the bubble */}
                {!message.isOptimistic && showMobileActions && (
                    <div 
                        className="mobile-actions-overlay"
                        ref={mobileActionsRef}
                    >
                        <div className={`mobile-actions ${isSender ? 'sender' : 'receiver'}`}>
                            {/* Reaction Button - Beside bubble */}
                            <button
                                className="mobile-action-btn reaction-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowReactionPicker(!showReactionPicker);
                                    setShowEmojiPicker(false);
                                    setReactionPickerPosition('default');
                                }}
                                title="Add reaction"
                            >
                                <Smile size={18} />
                                <span className="mobile-action-text">React</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* Display Reactions */}
                {Object.keys(reactionCounts).length > 0 && (
                    <div 
                        ref={reactionsBarRef}
                        className={`message-reactions ${isSender ? 'sender' : 'receiver'}`}
                    >
                        {Object.entries(reactionCounts).map(([emoji, data]) => (
                            <button
                                key={emoji}
                                className={`reaction-badge ${hasUserReacted(emoji) ? 'user-reacted' : ''}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleReaction(emoji);
                                }}
                                title={data.users.map(u => u?.name || 'Unknown').join(', ')}
                            >
                                <span className="reaction-emoji">{emoji}</span>
                                {data.count > 1 && <span className="reaction-count">{data.count}</span>}
                            </button>
                        ))}
                        
                        {/* Plus button in reactions display - Now opens full emoji picker */}
                        <button
                            className="reaction-badge reaction-add-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowEmojiPicker(!showEmojiPicker);
                                setShowReactionPicker(false);
                                setReactionPickerPosition('reactions-bar');
                                setShowMobileActions(false);
                            }}
                            title="Add reaction"
                        >
                            <span className="reaction-emoji">+</span>
                        </button>
                    </div>
                )}

                {/* Custom Reaction Picker - Now only shows quick reactions */}
                {showReactionPicker && (
                    <div 
                        ref={reactionPickerRef}
                        className={`reaction-picker ${isSender ? 'sender' : 'receiver'} ${reactionPickerPosition}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="reaction-picker-header">
                            <button
                                className="reaction-picker-close"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowReactionPicker(false);
                                }}
                                title="Close reaction picker"
                            >
                                ×
                            </button>
                        </div>
                        <div className="reaction-options">
                            {quickReactions.map(emoji => (
                                <button
                                    key={emoji}
                                    className={`reaction-option ${hasUserReacted(emoji) ? 'active' : ''}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleReaction(emoji);
                                    }}
                                    title={hasUserReacted(emoji) ? 'Remove reaction' : 'Add reaction'}
                                >
                                    {emoji}
                                </button>
                            ))}
                            
                            {/* More button now opens full emoji picker */}
                            <button
                                className="reaction-option reaction-more-btn"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowReactionPicker(false);
                                    setShowEmojiPicker(true);
                                    setReactionPickerPosition('default');
                                }}
                                title="More reactions"
                            >
                                +
                            </button>
                        </div>
                    </div>
                )}

                {/* Full Emoji Picker */}
                {showEmojiPicker && (
                    <div 
                        ref={emojiPickerRef}
                        className={`emoji-picker-container ${isSender ? 'sender' : 'receiver'} ${reactionPickerPosition}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            className="emoji-picker-close"
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowEmojiPicker(false);
                            }}
                            title="Close emoji picker"
                        >
                            ×
                        </button>
                        <EmojiPicker
                            onEmojiClick={handleEmojiPickerSelect}
                            width={300}
                            height={400}
                            searchDisabled={true}
                            skinTonesDisabled={true}
                            previewConfig={{
                                showPreview: false
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

export default MessageBubble;
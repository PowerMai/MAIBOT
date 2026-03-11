import { createContext, useContext, useState, ReactNode } from "react";

interface AppState {
  currentView: "dashboard" | "editor" | "sidebar" | "micro";
  editorContent: string;
  recentDocuments: Array<{
    id: string;
    title: string;
    content: string;
    lastEdit: Date;
    progress: number;
  }>;
  tasks: Array<{
    id: string;
    name: string;
    status: "pending" | "running" | "success" | "error";
    progress: number;
  }>;
  notifications: Array<{
    id: string;
    title: string;
    message: string;
    type: "info" | "success" | "warning" | "error";
    timestamp: Date;
    read: boolean;
  }>;
}

interface AppContextType {
  state: AppState;
  setCurrentView: (view: AppState["currentView"]) => void;
  updateEditorContent: (content: string) => void;
  addTask: (task: Omit<AppState["tasks"][0], "id">) => void;
  updateTask: (id: string, updates: Partial<AppState["tasks"][0]>) => void;
  addNotification: (notification: Omit<AppState["notifications"][0], "id" | "timestamp" | "read">) => void;
  markNotificationAsRead: (id: string) => void;
  addDocument: (doc: Omit<AppState["recentDocuments"][0], "id" | "lastEdit">) => void;
  updateDocument: (id: string, updates: Partial<AppState["recentDocuments"][0]>) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    currentView: "dashboard",
    editorContent: "",
    recentDocuments: [
      {
        id: "1",
        title: "XX项目投标方案",
        content: "# 项目投标方案\n\n## 1. 项目概述\n\n本项目旨在...",
        lastEdit: new Date(Date.now() - 7200000),
        progress: 75,
      },
      {
        id: "2",
        title: "技术规格说明书",
        content: "# 技术规格\n\n## 系统架构\n\n...",
        lastEdit: new Date(Date.now() - 86400000),
        progress: 100,
      },
    ],
    tasks: [],
    notifications: [
      {
        id: "1",
        title: "文档已更新",
        message: "XX项目投标方案已自动保存",
        type: "success",
        timestamp: new Date(Date.now() - 300000),
        read: false,
      },
    ],
  });

  const setCurrentView = (view: AppState["currentView"]) => {
    setState((prev) => ({ ...prev, currentView: view }));
  };

  const updateEditorContent = (content: string) => {
    setState((prev) => ({ ...prev, editorContent: content }));
  };

  const addTask = (task: Omit<AppState["tasks"][0], "id">) => {
    const newTask = {
      ...task,
      id: Date.now().toString(),
    };
    setState((prev) => ({
      ...prev,
      tasks: [...prev.tasks, newTask],
    }));
  };

  const updateTask = (id: string, updates: Partial<AppState["tasks"][0]>) => {
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((task) =>
        task.id === id ? { ...task, ...updates } : task
      ),
    }));
  };

  const addNotification = (
    notification: Omit<AppState["notifications"][0], "id" | "timestamp" | "read">
  ) => {
    const newNotification = {
      ...notification,
      id: Date.now().toString(),
      timestamp: new Date(),
      read: false,
    };
    setState((prev) => ({
      ...prev,
      notifications: [newNotification, ...prev.notifications],
    }));
  };

  const markNotificationAsRead = (id: string) => {
    setState((prev) => ({
      ...prev,
      notifications: prev.notifications.map((notif) =>
        notif.id === id ? { ...notif, read: true } : notif
      ),
    }));
  };

  const addDocument = (doc: Omit<AppState["recentDocuments"][0], "id" | "lastEdit">) => {
    const newDoc = {
      ...doc,
      id: Date.now().toString(),
      lastEdit: new Date(),
    };
    setState((prev) => ({
      ...prev,
      recentDocuments: [newDoc, ...prev.recentDocuments],
    }));
  };

  const updateDocument = (
    id: string,
    updates: Partial<AppState["recentDocuments"][0]>
  ) => {
    setState((prev) => ({
      ...prev,
      recentDocuments: prev.recentDocuments.map((doc) =>
        doc.id === id ? { ...doc, ...updates, lastEdit: new Date() } : doc
      ),
    }));
  };

  const value: AppContextType = {
    state,
    setCurrentView,
    updateEditorContent,
    addTask,
    updateTask,
    addNotification,
    markNotificationAsRead,
    addDocument,
    updateDocument,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
}

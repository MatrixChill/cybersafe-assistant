// ── Mock Prisma Client for Demo ──

export interface Company {
  name: string;
  size?: string;
  sector?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  type: "personal" | "business";
  plan: "free" | "pro" | "premium";
  company?: Company;
  createdAt: Date;
}

let users: User[] = [];

let threatEvents: any[] = [
  {
    id: "cl-1",
    source: "dashboard",
    url: "file://suspicious-file.exe",
    domain: "file-scan",
    severity: "critical",
    confidence: 0.98,
    rulesTriggered: ["dangerous_file_extension", "heuristic_match"],
    createdAt: new Date(Date.now() - 1000 * 60 * 5) // 5 mins ago
  },
  {
    id: "cl-2",
    source: "extension",
    url: "http://phishing-site.net/login",
    domain: "phishing-site.net",
    severity: "high",
    confidence: 0.85,
    rulesTriggered: ["known_phishing_domain"],
    createdAt: new Date(Date.now() - 1000 * 60 * 15) // 15 mins ago
  },
  {
    id: "cl-3",
    source: "download-monitor",
    url: "http://legit-site.com/setup.zip",
    domain: "legit-site.com",
    severity: "low",
    confidence: 0.1,
    rulesTriggered: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 60) // 1 hour ago
  }
];

let trainingResults: any[] = [];

export const prisma = {
  // ── User methods ──
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }): Promise<User | null> => {
      if (where.email) {
        return users.find((u) => u.email === where.email) || null;
      }
      if (where.id) {
        return users.find((u) => u.id === where.id) || null;
      }
      return null;
    },
    create: async ({ data }: { data: Omit<User, "id" | "createdAt"> }): Promise<User> => {
      const newUser: User = {
        ...data,
        id: `usr-${Math.random().toString(36).substring(2, 10)}`,
        createdAt: new Date(),
      };
      users.push(newUser);
      return newUser;
    },
  },

  // ── Threat Event methods ──
  threatEvent: {
    findMany: async (args?: any) => {
      let result = [...threatEvents];
      if (args?.orderBy?.createdAt === 'desc') {
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (args?.take) {
        result = result.slice(0, args.take);
      }
      return result;
    },
    create: async ({ data }: any) => {
      const newEvent = { 
        ...data, 
        id: `m-${Math.random().toString(36).substring(7)}`,
        createdAt: data.createdAt || new Date()
      };
      threatEvents.push(newEvent);
      return newEvent;
    },
    createMany: async ({ data }: any) => {
      const news = data.map((d: any) => ({
        ...d,
        id: `m-${Math.random().toString(36).substring(7)}`,
        createdAt: d.createdAt || new Date()
      }));
      threatEvents.push(...news);
      return { count: news.length };
    },
    deleteMany: async () => {
      const count = threatEvents.length;
      threatEvents = [];
      return { count };
    }
  },

  // ── Training Result methods ──
  trainingResult: {
    findMany: async (args?: any) => {
      let result = [...trainingResults];
      if (args?.orderBy?.completedAt === 'desc') {
        result.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
      }
      if (args?.take) {
        result = result.slice(0, args.take);
      }
      return result;
    },
    create: async ({ data }: any) => {
      const newResult = { 
        ...data, 
        id: `tr-${Math.random().toString(36).substring(7)}`,
        completedAt: new Date() 
      };
      trainingResults.push(newResult);
      return newResult;
    }
  }
};

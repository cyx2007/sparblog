import settings from './settings/site.json';
import { siteSettingsSchema } from '../lib/site-settings-schema.mjs';

const content = siteSettingsSchema.parse(settings);

export const site = {
  name: 'sparsity.tech',
  url: 'https://sparsity.tech',
  description: content.description,
  about: content.about,
  copyrightName: '稀疏札记',
  pageSize: 4,
  registration: {
    icp: {
      number: '粤ICP备2026118989号',
      url: 'https://beian.miit.gov.cn/',
    },
    police: {
      number: '粤公网安备44030002016095号',
      url: 'https://beian.mps.gov.cn/#/query/webSearch?code=44030002016095',
      icon: '/beian.png',
    },
  },
};

export const navItems = [
  { label: '首页', path: '/' },
  { label: '归档', path: '/archive/' },
  { label: '关于', path: '/about/' },
];

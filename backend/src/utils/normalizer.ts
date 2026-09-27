// Comprehensive Data Normalizers & Column Mapping Utilities

export const ALIASES: Record<string, string[]> = {
  business_name: ['business_name', 'business name', 'company', 'company name', 'client name', 'name', 'store name'],
  whatsapp_number: [
    'whatsapp', 'whatsapp number', 'whatsapp_number', 'whatsapp no', 
    'phone', 'phone number', 'phone_number', 'mobile', 'mobile number', 'mobile_number',
    'contact', 'contact number', 'contact_number', 'business phone', 'telephone'
  ],
  instagram_username: [
    'instagram', 'instagram handle', 'instagram username', 'instagram_username', 
    'ig', 'ig username', 'instagram url', 'ig handle'
  ],
  city: ['city', 'location', 'place', 'town'],
  business_type: ['category', 'business type', 'business_type', 'industry', 'type'],
  website: ['website', 'website url', 'url', 'site', 'web'],
  contact_name: ['contact_name', 'contact name', 'contact person', 'person', 'owner', 'manager'],
  email: ['email', 'email address', 'e-mail'],
  whatsapp_opt_in: ['whatsapp_opt_in', 'whatsapp opt in', 'opt in', 'consent', 'optin']
};

export function normalizePhone(rawPhone: string): string | null {
  if (!rawPhone) return null;

  let cleaned = String(rawPhone).trim().replace(/[\s\-\(\)]/g, '');
  if (!cleaned) return null;

  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('0') && cleaned.length === 11) cleaned = cleaned.substring(1);
  if (cleaned.length === 10) return '+91' + cleaned;
  
  return cleaned;
}

export function normalizeInstagram(rawIg: string): string | null {
  if (!rawIg) return null;
  let cleaned = String(rawIg).trim().toLowerCase();
  if (cleaned.startsWith('@')) cleaned = cleaned.substring(1);
  if (cleaned.includes('instagram.com/')) {
    cleaned = cleaned.split('instagram.com/')[1].split('/')[0].split('?')[0];
  }
  return cleaned || null;
}

export function normalizeCategory(rawCat: string): string | null {
  if (!rawCat) return null;
  return String(rawCat).trim();
}

export function normalizeCity(rawCity: string): string | null {
  if (!rawCity) return null;
  return String(rawCity).trim();
}

export function normalizeStatus(rawStatus: string): string {
  if (!rawStatus) return 'NEW';
  return String(rawStatus).toUpperCase().trim().replace(/\s+/g, '_');
}

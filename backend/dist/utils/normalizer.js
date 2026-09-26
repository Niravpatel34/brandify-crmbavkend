// Comprehensive Data Normalizers & Column Mapping Utilities
export const ALIASES = {
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
export function normalizePhone(rawPhone) {
    if (!rawPhone)
        return { normalized: '', isValid: false };
    // Strip whitespace, hyphens, brackets, leading zeros if part of local prefix
    let cleaned = String(rawPhone).trim().replace(/[\s\-\(\)]/g, '');
    if (!cleaned)
        return { normalized: '', isValid: false };
    // If starts with + (international format)
    if (cleaned.startsWith('+')) {
        const isNum = /^\+\d{10,15}$/.test(cleaned);
        return { normalized: cleaned, isValid: isNum };
    }
    // Handle leading 0 (e.g., 09876543210)
    if (cleaned.startsWith('0') && cleaned.length === 11) {
        cleaned = cleaned.substring(1);
    }
    // 10 digits starting with 6, 7, 8, 9 -> Indian mobile number
    if (/^[6789]\d{9}$/.test(cleaned)) {
        return { normalized: `+91${cleaned}`, isValid: true };
    }
    // 12 digits starting with 91 (Indian country code)
    if (/^91[6789]\d{9}$/.test(cleaned)) {
        return { normalized: `+${cleaned}`, isValid: true };
    }
    // Generic digits check (10 to 14 digits)
    if (/^\d{10,14}$/.test(cleaned)) {
        return { normalized: `+${cleaned}`, isValid: true };
    }
    return { normalized: cleaned, isValid: false };
}
export function normalizeInstagram(rawInsta) {
    if (!rawInsta)
        return '';
    let cleaned = String(rawInsta).trim();
    // Strip protocol and domain if present
    cleaned = cleaned.replace(/^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/?/i, '');
    // Strip leading @
    cleaned = cleaned.replace(/^@+/, '');
    // Take first path segment before trailing slashes or queries
    cleaned = cleaned.split('/')[0].split('?')[0].split('#')[0].trim();
    // Final cleanup of @ and lowercase
    cleaned = cleaned.replace(/^@+/, '').toLowerCase();
    return cleaned;
}
export function normalizeCategory(rawCategory) {
    if (!rawCategory)
        return 'Other';
    const cat = String(rawCategory).trim().toLowerCase();
    if (cat.includes('clinic') || cat.includes('dental') || cat.includes('medical') || cat.includes('doctor'))
        return 'Clinic';
    if (cat.includes('gym') || cat.includes('fitness') || cat.includes('workout'))
        return 'Gym';
    if (cat.includes('cafe') || cat.includes('café') || cat.includes('coffee'))
        return 'Cafe';
    if (cat.includes('restaurant') || cat.includes('restro') || cat.includes('resto') || cat.includes('dining'))
        return 'Restaurant';
    if (cat.includes('salon') || cat.includes('parlour') || cat.includes('beauty') || cat.includes('hair'))
        return 'Salon';
    if (cat.includes('jewel') || cat.includes('gold'))
        return 'Jewellery';
    if (cat.includes('hotel') || cat.includes('resort') || cat.includes('stay'))
        return 'Hotel';
    if (cat.includes('travel') || cat.includes('tour') || cat.includes('agency'))
        return 'Travel';
    if (cat.includes('fashion') || cat.includes('apparel') || cat.includes('clothing') || cat.includes('boutique'))
        return 'Fashion';
    if (cat.includes('real estate') || cat.includes('realty') || cat.includes('property') || cat.includes('builder'))
        return 'Real Estate';
    if (cat.includes('e-commerce') || cat.includes('ecommerce') || cat.includes('shopify') || cat.includes('store'))
        return 'E-Commerce';
    // Capitalize title case
    return cat.charAt(0).toUpperCase() + cat.slice(1);
}
export function normalizeCity(rawCity) {
    if (!rawCity)
        return '';
    const cleaned = String(rawCity).trim();
    if (!cleaned)
        return '';
    // Title case city name (e.g. AHMEDABAD -> Ahmedabad)
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}
export function normalizeStatus(rawStatus) {
    if (!rawStatus)
        return 'NEW';
    const s = String(rawStatus).trim().toUpperCase();
    const validStatuses = [
        'NEW', 'INCOMPLETE', 'CONTACTED', 'REPLIED', 'QUALIFIED',
        'MEETING', 'PROPOSAL', 'CLIENT', 'LOST',
        'DO_NOT_CONTACT', 'VALIDATED', 'NOT_ELIGIBLE',
        'READY', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED',
        'READ', 'INTERESTED', 'NOT_INTERESTED', 'OPTED_OUT', 'FAILED'
    ];
    if (validStatuses.includes(s))
        return s;
    return 'NEW';
}

/**
 * Tests for error handler utilities
 */

import { describeError, describeToolError, isNotFoundError } from '../../src/utils/error-handler.js';

describe('Error Handler', () => {
  describe('Error Types', () => {
    it('should define error types', () => {
      const ErrorType = {
        NETWORK_ERROR: 'NETWORK_ERROR',
        PARSE_ERROR: 'PARSE_ERROR',
        NOT_FOUND: 'NOT_FOUND',
        INVALID_INPUT: 'INVALID_INPUT',
        TIMEOUT: 'TIMEOUT',
        UNKNOWN: 'UNKNOWN',
      };

      expect(ErrorType.NETWORK_ERROR).toBe('NETWORK_ERROR');
      expect(ErrorType.PARSE_ERROR).toBe('PARSE_ERROR');
      expect(ErrorType.NOT_FOUND).toBe('NOT_FOUND');
      expect(ErrorType.INVALID_INPUT).toBe('INVALID_INPUT');
      expect(ErrorType.TIMEOUT).toBe('TIMEOUT');
      expect(ErrorType.UNKNOWN).toBe('UNKNOWN');
    });
  });

  describe('Error Response Creation', () => {
    it('should create formatted error response', () => {
      const error = {
        type: 'NETWORK_ERROR',
        message: 'Network error occurred',
        suggestions: ['Check connection', 'Try again']
      };

      const response = {
        isError: true,
        content: [{
          type: 'text',
          text: `Error: ${error.message}\n\nSuggestions:\n• ${error.suggestions.join('\n• ')}`
        }]
      };

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Error: Network error occurred');
      expect(response.content[0].text).toContain('• Check connection');
      expect(response.content[0].text).toContain('• Try again');
    });

    it('should create error response without suggestions', () => {
      const error = {
        type: 'UNKNOWN',
        message: 'Unknown error'
      };

      const response = {
        isError: true,
        content: [{
          type: 'text',
          text: `Error: ${error.message}`
        }]
      };

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toBe('Error: Unknown error');
    });
  });

  describe('Input Validation', () => {
    it('should validate non-empty strings', () => {
      const validateInput = (value: string, fieldName: string, minLength: number = 1) => {
        if (!value || value.trim().length < minLength) {
          return {
            type: 'INVALID_INPUT',
            message: `${fieldName} is required and must be at least ${minLength} character(s)`,
            suggestions: [
              `Provide a valid ${fieldName.toLowerCase()}`,
              'Check the parameter format',
            ],
          };
        }
        return null;
      };

      expect(validateInput('valid input', 'Test Field')).toBeNull();
      
      const emptyResult = validateInput('', 'Test Field');
      expect(emptyResult?.type).toBe('INVALID_INPUT');
      expect(emptyResult?.message).toContain('Test Field is required');
      
      const shortResult = validateInput('ab', 'Test Field', 3);
      expect(shortResult?.type).toBe('INVALID_INPUT');
      expect(shortResult?.message).toContain('must be at least 3 character(s)');
    });
  });

  describe('describeError', () => {
    it('should return the message of a real Error', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
    });

    it('should return the message of a plain AppError object instead of [object Object]', () => {
      const appError = { type: 'API_ERROR', message: 'Failed to fetch data', suggestions: [] };
      expect(describeError(appError)).toBe('Failed to fetch data');
      expect(describeError(appError)).not.toBe('[object Object]');
    });

    it('should return strings unchanged', () => {
      expect(describeError('plain string error')).toBe('plain string error');
    });

    it('should stringify unknown primitive values', () => {
      expect(describeError(42)).toBe('42');
      expect(describeError(null)).toBe('null');
      expect(describeError(undefined)).toBe('undefined');
    });

    it('should serialize plain objects that have no message', () => {
      expect(describeError({ code: 'E_TEST', detail: 'nope' })).toBe('{"code":"E_TEST","detail":"nope"}');
    });

    it('should handle circular objects without throwing', () => {
      const circular: any = { code: 'E_CIRCULAR' };
      circular.self = circular;
      expect(() => describeError(circular)).not.toThrow();
      expect(typeof describeError(circular)).toBe('string');
    });
  });

  describe('describeToolError', () => {
    it('should prefix the tool name', () => {
      expect(describeToolError('get_related_apis', new Error('Network error')))
        .toBe('get_related_apis failed: Network error');
    });

    it('should append the documentation-page hint for 404 / Not Found', () => {
      expect(describeToolError('get_related_apis', new Error('Request failed with status 404')))
        .toContain('the URL may not be a documentation page');
      expect(isNotFoundError(new Error('Not Found'))).toBe(true);
      expect(isNotFoundError(new Error('Network error'))).toBe(false);
    });

    it('should use an explicit hint instead of the default one', () => {
      const message = describeToolError(
        'search_framework_symbols',
        new Error('404 Not Found'),
        'framework "uikitx" not found; call list_technologies for valid identifiers',
      );
      expect(message).toContain('framework "uikitx" not found; call list_technologies for valid identifiers');
      expect(message).not.toContain('documentation page');
    });

    it('should render a plain AppError object without [object Object]', () => {
      expect(describeToolError('get_related_apis', { type: 'NOT_FOUND', message: 'missing' }))
        .toBe('get_related_apis failed: missing');
    });
  });
});